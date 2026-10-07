import { defineStore } from 'pinia'

// 只读角色：可以查看台账，但任何调度动作都要被服务层拒绝。
const READONLY_ROLES = ['viewer', 'observer', 'readonly']

export const useSessionStore = defineStore('session', {
  state: () => ({
    operator: '值班管理员',
    role: 'admin',
    shiftLabel: '白班 08:00-20:00',
    scope: '机场地面保障调度管理系统',
  }),
  getters: {
    canOperate: (state) =>
      state.operator.trim().length > 0 && !READONLY_ROLES.includes(state.role),
    isReadonly: (state) => READONLY_ROLES.includes(state.role),
  },
  actions: {
    setShift(label: string) {
      this.shiftLabel = label
    },
    setOperator(operator: string) {
      this.operator = operator
    },
    setRole(role: string) {
      this.role = role
    },
  },
})
