import { defineStore } from 'pinia'

// 只读角色只能看台账，任何状态流转在数据层都会被拒绝。
export const ROLES = ['值班管理员', '调度员', '只读用户'] as const
export type Role = (typeof ROLES)[number]

export const useSessionStore = defineStore('session', {
  state: () => ({
    operator: '值班管理员',
    role: '调度员' as Role,
    roles: ROLES as unknown as string[],
    shiftLabel: '白班 08:00-20:00',
    scope: '机场地面保障调度管理系统',
  }),
  getters: {
    canOperate: (state) => state.operator.length > 0 && state.role !== '只读用户',
  },
  actions: {
    setShift(label: string) {
      this.shiftLabel = label
    },
    setRole(role: Role) {
      this.role = role
      if (role === '值班管理员') {
        this.operator = '值班管理员'
      }
    },
  },
})
