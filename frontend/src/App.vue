<template>
  <div class="app-shell">
    <aside class="app-side">
      <h1 class="app-title">机场地面保障调度管理系统</h1>
      <nav class="nav-list">
        <RouterLink v-for="item in navItems" :key="item.path" :to="item.path" class="nav-item">
          {{ item.label }}
        </RouterLink>
      </nav>
    </aside>
    <main class="app-main">
      <header class="app-head">
        <span class="head-desc">面向航班机位分配、廊桥调度、行李转运、货物装卸、航空加油、航食配餐与客舱清洁全流程的机场地面保障调度管理平台。</span>
        <span class="head-user">
          当前值班：{{ store.operator }}（{{ roleLabel }}）· {{ store.shiftLabel }}
          <button class="btn head-switch" type="button" @click="toggleRole">
            切换为{{ store.isReadonly ? '调度员' : '只读账号' }}
          </button>
        </span>
      </header>
      <RouterView />
    </main>
  </div>
</template>

<script setup lang="ts">
import { computed, watchEffect } from 'vue'

import { setOperatorContext } from '@/api/local-service'
import { useSessionStore } from '@/stores/session'

const store = useSessionStore()

const roleLabel = computed(() => (store.isReadonly ? '只读' : '调度员'))

function toggleRole() {
  store.setRole(store.isReadonly ? 'admin' : 'viewer')
}

// 会话里的操作人员与角色是服务层鉴权的唯一来源，切换后立即同步。
watchEffect(() => {
  setOperatorContext({ operator: store.operator, role: store.role })
})

const navItems = [{ label: "运营概览", path: "/" }, { label: "机位分配", path: "/stand" }, { label: "廊桥调度", path: "/bridge" }, { label: "地面电源", path: "/ground_power" }, { label: "行李转运", path: "/baggage" }, { label: "货物装卸", path: "/cargo" }, { label: "航空加油", path: "/fueling" }, { label: "航食配餐", path: "/catering" }, { label: "客舱清洁", path: "/cabin_clean" }, { label: "排污服务", path: "/lavatory" }, { label: "除冰作业", path: "/deicing" }, { label: "牵引车调度", path: "/pushback" }, { label: "地勤排班", path: "/crew_schedule" }, { label: "特种车辆", path: "/special_vehicle" }, { label: "航班保障", path: "/flight_ops" }, { label: "过站监控", path: "/turnaround" }, { label: "机坪安全", path: "/apron_safety" }, { label: "装卸设备", path: "/load_equip" }, { label: "应急保障", path: "/air_emergency" }]
</script>
