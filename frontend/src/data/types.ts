/** 纯前端数据层的公共类型：与全栈版后端返回的结构保持一致，换回后端时页面不用改。 */

export type EntryRow = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  [field: string]: string | number | boolean
}

export type ModuleMeta = {
  key: string
  name: string
  entity: string
  desc: string
  fields: string[]
  statuses: string[]
  actions: string[]
  actionTargets: Record<string, string>
  metrics: string[]
  // 终态集合：落到这些状态后不再算待处理；不配置时默认取状态序列最后一个。
  terminalStatuses?: string[]
}

export type PageResult = {
  items: EntryRow[]
  total: number
  page: number
  size: number
}

export type ActionResult = {
  ok: boolean
  message: string
  // 写入成功后回填：当前规范状态、关联机位及其占用结论，保证列表/详情/台账同源。
  status?: string
  linkedStandId?: number
  occupancy?: string
}

// 调度动作的操作人员上下文；只读角色或没有调度人员身份的调用一律拒绝。
export type ActionOptions = {
  operator?: string
  role?: string
}

export type OverviewResult = {
  cards: { label: string; value: number }[]
  modules: { name: string; created: number; pending: number; abnormal: number }[]
}
