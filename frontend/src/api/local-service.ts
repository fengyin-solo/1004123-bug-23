import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, commitRows, listRows, resetRows } from '@/data/local-store'
import type {
  ActionOptions,
  ActionResult,
  EntryRow,
  ModuleMeta,
  OverviewResult,
  PageResult,
} from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

// 只有这些角色能做写操作；只读账号越权改写一律拒绝。
const WRITABLE_ROLES = ['admin', 'dispatcher', 'operator']

// 默认操作人员上下文，页面挂载时会用当前登录会话覆盖。
const operatorContext: { operator: string; role: string } = {
  operator: '值班管理员',
  role: 'admin',
}

// 廊桥调度的合法状态流转：每个动作只能从给定的源状态发起，
// 防止跳节点改写（比如已脱离的廊桥再点「确认脱离」、故障廊桥直接对接）。
const BRIDGE_ACTION_SOURCES: Record<string, string[]> = {
  安排对接: ['待对接'],
  确认脱离: ['已对接'],
  停用报修: ['待对接', '已对接'],
}

// 廊桥状态联动到机位台账的占用结论，三处必须同一份事实。
const BRIDGE_STAND_STATUS: Record<string, string> = {
  已对接: '占用中',
  已脱离: '已释放',
}

// 廊桥动作对应的时间节点字段：成功流转时登记，失败不写。
const BRIDGE_ACTION_TIME_FIELD: Record<string, string> = {
  安排对接: '实际对接',
  确认脱离: '脱离时间',
}

// 机位分配同样不允许跳节点：必须先分配再占用、释放。
const STAND_ACTION_SOURCES: Record<string, string[]> = {
  分配机位: ['空闲'],
  确认占用: ['已分配'],
  释放机位: ['占用中'],
}

export function setOperatorContext(options: ActionOptions): void {
  if (options.operator !== undefined) {
    operatorContext.operator = options.operator
  }
  if (options.role !== undefined) {
    operatorContext.role = options.role
  }
}

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const matched = filterRows(listRows(key), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

// 列表、详情、占用结论共用的唯一读取入口：永远读台账里的规范状态。
export function getEntry(key: string, id: number): EntryRow | null {
  return listRows(key).find((row) => Number(row.id) === id) ?? null
}

function terminalStatusesOf(meta: ModuleMeta): Set<string> {
  return new Set(meta.terminalStatuses ?? [meta.statuses[meta.statuses.length - 1]])
}

// 业务状态字段是字段序列中以「状态」结尾的那个（如「廊桥状态」「分配状态」），
// 它必须与规范 status 保持一致，否则详情页会读到过期结论。
function statusFieldOf(meta: ModuleMeta): string | null {
  return [...meta.fields].reverse().find((field) => field.endsWith('状态')) ?? null
}

function nowText(): string {
  const now = new Date()
  const pad = (value: number) => String(value).padStart(2, '0')
  return (
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ` +
    `${pad(now.getHours())}:${pad(now.getMinutes())}`
  )
}

function isNegativeAction(action: string): boolean {
  return NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb))
}

// 故障停用属于终态异常：异常标记一旦打上就粘住，后续合法流转（重新对接/确认脱离）才解除，
// 避免「返回后故障停用记录丢失」。
function resolveAbnormal(
  meta: ModuleMeta,
  current: EntryRow,
  action: string,
  target: string,
): boolean {
  if (meta.key === 'bridge') {
    if (target === '故障停用') {
      return true
    }
    return target === '已脱离' ? false : Boolean(current.abnormal)
  }
  return isNegativeAction(action) ? true : Boolean(current.abnormal)
}

function isTransitionAllowed(meta: ModuleMeta, action: string, current: string): boolean {
  if (meta.key === 'bridge') {
    return (BRIDGE_ACTION_SOURCES[action] ?? []).includes(current)
  }
  if (meta.key === 'stand') {
    return (STAND_ACTION_SOURCES[action] ?? []).includes(current)
  }
  // 其余模块保持顺序机语义：只允许沿状态序列向前流转，不允许回退、跳节点。
  const from = meta.statuses.indexOf(current)
  const to = meta.statuses.indexOf(meta.actionTargets[action] ?? '')
  if (from < 0 || to < 0) {
    return false
  }
  return to > from
}

// 按「所属机位」找到廊桥当前占用的机位台账记录。
export function linkedStandOf(bridge: EntryRow): { stand: EntryRow; occupancy: string } | null {
  const standNo = String(bridge['所属机位'] ?? '').trim()
  if (!standNo) {
    return null
  }
  const stand = listRows('stand').find((item) => String(item['机位编号']).trim() === standNo)
  if (!stand) {
    return null
  }
  return { stand, occupancy: String(stand.status) }
}

export function runAction(
  key: string,
  id: number,
  action: string,
  options: ActionOptions = {},
): ActionResult {
  const meta = moduleMeta(key)
  const operator = options.operator ?? operatorContext.operator
  const role = options.role ?? operatorContext.role

  // 越权写入先拦：没有调度人员身份或只读角色，拒绝且不动任何数据。
  if (!operator || !String(operator).trim()) {
    return { ok: false, message: '无法识别调度人员身份，拒绝执行该操作' }
  }
  if (!WRITABLE_ROLES.includes(role)) {
    return { ok: false, message: `当前角色「${role}」只有查看权限，不能${action}` }
  }

  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }

  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const currentRow = rows[index]
  const current = String(currentRow.status)
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  if (!isTransitionAllowed(meta, action, current)) {
    return {
      ok: false,
      message: `${meta.entity}当前为「${current}」，不能执行「${action}」`,
    }
  }

  // 所有副本在同一遍计算里更新：规范状态、业务状态字段、时间节点、待处理/异常标记。
  const statusField = statusFieldOf(meta)
  const terminals = terminalStatusesOf(meta)
  const updated: EntryRow = {
    ...currentRow,
    status: target,
    pending: !terminals.has(target),
    abnormal: resolveAbnormal(meta, currentRow, action, target),
  }
  if (statusField) {
    updated[statusField] = target
  }
  if (meta.key === 'bridge') {
    const timeField = BRIDGE_ACTION_TIME_FIELD[action]
    if (timeField) {
      updated[timeField] = nowText()
    }
  }

  const nextRows = [...rows]
  nextRows[index] = updated

  // 廊桥与机位台账的联动放在同一原子提交里：同成同败。
  const patches: Array<[string, EntryRow[]]> = [[key, nextRows]]
  let linkedStandId: number | undefined
  let occupancy: string | undefined
  if (meta.key === 'bridge') {
    const standTarget = BRIDGE_STAND_STATUS[target]
    if (standTarget) {
      const standNo = String(updated['所属机位'] ?? '').trim()
      const standRows = listRows('stand')
      const standIndex = standRows.findIndex(
        (item) => String(item['机位编号']).trim() === standNo,
      )
      if (standIndex >= 0) {
        const standRow = standRows[standIndex]
        const standMeta = moduleMeta('stand')
        const standField = statusFieldOf(standMeta)
        const releasedStand: EntryRow = {
          ...standRow,
          status: standTarget,
          pending: !terminalStatusesOf(standMeta).has(standTarget),
        }
        if (standField) {
          releasedStand[standField] = standTarget
        }
        const nextStandRows = [...standRows]
        nextStandRows[standIndex] = releasedStand
        patches.push(['stand', nextStandRows])
        linkedStandId = Number(releasedStand.id)
        occupancy = standTarget
      }
    }
  }

  try {
    // 提交前所有数据都已算好；落库失败则缓存不动，本次无任何残留，可在原记录上重试。
    commitRows(patches)
  } catch {
    return { ok: false, message: `${meta.entity}${action}未保存成功，请在原记录上重试` }
  }

  let message = `${meta.entity}已${action}，当前状态「${target}」`
  if (meta.key === 'bridge' && linkedStandId !== undefined && occupancy !== undefined) {
    message +=
      occupancy === '已释放'
        ? `，关联机位台账已同步释放`
        : `，关联机位台账已同步置为占用中`
  }
  return { ok: true, message, status: target, linkedStandId, occupancy }
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of listRows(key)) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `﻿${lines.join('\n')}` }
}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function loadOverview(): OverviewResult {
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = rows[meta.key] ?? []
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}
