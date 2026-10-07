import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, listRows, resetRows, saveAll } from '@/data/local-store'
import type {
  ActionResult,
  Actor,
  EntryRow,
  ModuleMeta,
  OverviewResult,
  PageResult,
  RunActionOptions,
} from '@/data/types'

// 会写进数据的「往回走」动作：命中后该记录进入异常态，且之后的正常动作不能把异常痕迹抹掉。
const NEGATIVE_VERBS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚', '报修', '异常', '中断', '取消', '复查', '超时', '延误']

// 只分配了只读角色的账号：能看台账，但任何状态流转都必须拒绝。
const READONLY_ROLES = ['只读用户', '观察员', 'viewer']

// 由应用层（Pinia 会话）注入当前操作人；页面调动作时不用逐个传参。
type SessionReader = () => Actor | null
let sessionReader: SessionReader | null = null

export function bindSession(reader: SessionReader): void {
  sessionReader = reader
}

function resolveActor(options?: RunActionOptions): Actor {
  if (options?.actor) {
    return options.actor
  }
  const session = sessionReader?.()
  if (session) {
    return session
  }
  return { operator: '值班管理员', role: '调度员' }
}

function isNegativeAction(action: string): boolean {
  return NEGATIVE_VERBS.some((verb) => action.includes(verb))
}

// 模块自己声明的异常状态（故障停用/异常滞留/已取消…），与动作是否为异常类互为印证。
function isAbnormalStatus(meta: ModuleMeta, status: string): boolean {
  if (!meta.statuses.includes(status)) {
    return false
  }
  if (/故障|异常|中断|取消|超时|报修|停用|滞留|延误/.test(status)) {
    return true
  }
  return meta.actions.some(
    (action) => isNegativeAction(action) && meta.actionTargets[action] === status,
  )
}

// 台账里与 status 同源的镜像状态字段（廊桥状态、分配状态…）。
// 之前它从不随动作更新，是「列表已脱离、详情还显示已对接」的根因。
function statusField(meta: ModuleMeta): string | null {
  return meta.fields.find((field) => field.endsWith('状态')) ?? null
}

// 动作允许从哪些状态发起：正常动作只认上一环，异常类动作可从任意未终态/非异常状态报修。
// 约束住前置状态后，越权修改（已脱离又改回已对接）会在写盘前被拒绝。
function allowedCurrentStatuses(meta: ModuleMeta, action: string, target: string): string[] {
  const targetIndex = meta.statuses.indexOf(target)
  if (isNegativeAction(action)) {
    return meta.statuses.filter(
      (status) => status !== target && !isAbnormalStatus(meta, status),
    )
  }
  return targetIndex > 0 ? [meta.statuses[targetIndex - 1]] : [target]
}

// 正常收尾状态：模块最后一个非异常动作的目标（已释放/已脱离/已完成/已闭环…）。
function terminalStatuses(meta: ModuleMeta): Set<string> {
  const set = new Set<string>()
  for (let i = meta.actions.length - 1; i >= 0; i -= 1) {
    const action = meta.actions[i]
    if (!isNegativeAction(action)) {
      set.add(meta.actionTargets[action])
      break
    }
  }
  for (const status of meta.statuses) {
    if (isAbnormalStatus(meta, status)) {
      set.add(status)
    }
  }
  return set
}

// 待处理：未正常收尾且未进入异常终态的记录仍挂起，收尾/异常后残留标记清空。
function isPendingStatus(meta: ModuleMeta, status: string): boolean {
  return !terminalStatuses(meta).has(status)
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

// 廊桥对接/脱离要同步机位分配台账：按廊桥的「所属机位」对机位编号原位更新，
// 不新增任何记录，避免机位页读到重复条目。
function linkedStandTarget(meta: ModuleMeta, action: string): string | null {
  if (meta.key !== 'bridge') {
    return null
  }
  if (action === '安排对接') {
    return '占用中'
  }
  if (action === '确认脱离') {
    return '已释放'
  }
  return null
}

export function runAction(
  key: string,
  id: number,
  action: string,
  options?: RunActionOptions,
): ActionResult {
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }

  const actor = resolveActor(options)
  if (READONLY_ROLES.includes(actor.role)) {
    return { ok: false, message: `${actor.operator}（${actor.role}）只有查看权限，不能执行「${action}」` }
  }

  const snapshot = allRows()
  const rows = snapshot[key] ?? []
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }

  const current = String(rows[index].status)
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  if (!allowedCurrentStatuses(meta, action, target).includes(current)) {
    // 前置状态不符：原记录、历史状态一律不动。
    return { ok: false, message: `${meta.entity}当前为「${current}」，不能执行「${action}」` }
  }

  // 异常痕迹只增不减：已故障停用的记录，后续任何流转都保留 abnormal=true。
  const abnormal =
    rows[index].abnormal === true || isNegativeAction(action) || isAbnormalStatus(meta, target)
  const mirror = statusField(meta)
  const updated: EntryRow = {
    ...rows[index],
    status: target,
    pending: isPendingStatus(meta, target),
    abnormal,
  }
  if (mirror) {
    updated[mirror] = target
  }

  const nextRows = [...rows]
  nextRows[index] = updated

  // 廊桥台账与机位台账在同一次提交里落盘，任一失败全部回滚，重试仍从原记录继续。
  const nextSnapshot: Record<string, EntryRow[]> = { ...snapshot, [key]: nextRows }
  let linkedMessage = ''
  const standTarget = linkedStandTarget(meta, action)
  if (standTarget) {
    const standMeta = moduleMeta('stand')
    const standRows = nextSnapshot.stand ?? []
    const position = String(updated['所属机位'] ?? '')
    const standIndex = standRows.findIndex((row) => String(row['机位编号'] ?? '') === position)
    if (standIndex >= 0) {
      const linked: EntryRow = {
        ...standRows[standIndex],
        status: standTarget,
        pending: isPendingStatus(standMeta, standTarget),
      }
      const standMirror = statusField(standMeta)
      if (standMirror) {
        linked[standMirror] = standTarget
      }
      const nextStandRows = [...standRows]
      nextStandRows[standIndex] = linked
      nextSnapshot.stand = nextStandRows
      linkedMessage = `，机位 ${position} 已同步${standTarget === '占用中' ? '置为占用中' : '释放'}`
    }
  }

  try {
    saveAll(nextSnapshot)
  } catch {
    // 提交失败不替换内存台账，调用方重试时读到的仍是原记录，不会重复写。
    return { ok: false, message: `${meta.entity}「${action}」提交失败，请在原记录上重试` }
  }
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」${linkedMessage}` }
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

// 当前记录在当前状态下还能执行哪些动作，供页面按行渲染，避免用户点了才被拒。
export function availableActions(key: string, row: EntryRow): string[] {
  const meta = moduleMeta(key)
  const current = String(row.status)
  return meta.actions.filter((action) => {
    const target = meta.actionTargets[action]
    if (!target || target === current) {
      return false
    }
    return allowedCurrentStatuses(meta, action, target).includes(current)
  })
}

// 启动时一次性修正历史脏数据：镜像状态字段对齐 status、清掉残留 pending、
// 异常痕迹只补不消，并按 id 去重（防止早前非原子写入留下重复条目）。
export function reconcileStorage(): void {
  const snapshot = allRows()
  let changed = false
  const next: Record<string, EntryRow[]> = {}

  for (const key of Object.keys(snapshot)) {
    const meta = MODULE_BY_KEY.get(key)
    if (!meta) {
      next[key] = snapshot[key]
      continue
    }
    const mirror = statusField(meta)
    const seen = new Set<number>()
    next[key] = snapshot[key].filter((row) => {
      const rid = Number(row.id)
      if (seen.has(rid)) {
        changed = true
        return false
      }
      seen.add(rid)
      return true
    }).map((row) => {
      const fixed: EntryRow = { ...row }
      const status = String(row.status ?? '')
      if (mirror && fixed[mirror] !== status) {
        fixed[mirror] = status
        changed = true
      }
      const expectedPending = meta.statuses.includes(status) ? isPendingStatus(meta, status) : true
      if (fixed.pending !== expectedPending) {
        fixed.pending = expectedPending
        changed = true
      }
      // 历史故障停用记录保留 abnormal=true，迁移只补不消。
      const expectedAbnormal = fixed.abnormal === true || isAbnormalStatus(meta, status)
      if (fixed.abnormal !== expectedAbnormal) {
        fixed.abnormal = expectedAbnormal
        changed = true
      }
      return fixed
    })
  }

  if (changed) {
    try {
      saveAll(next)
    } catch {
      // 老数据修正失败不阻塞启动，下一次动作提交仍有前置校验兜底。
    }
  }
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of listRows(key)) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `\uFEFF${lines.join('\n')}` }
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
