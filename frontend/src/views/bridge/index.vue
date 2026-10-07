<template>
  <section class="page" data-module="bridge">
    <header class="page-head">
      <div>
        <h2>廊桥调度管理</h2>
        <p class="page-desc">维护廊桥，围绕廊桥编号、所属机位、对接机型、调度人员做登记、筛选与状态流转。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记廊桥</button>
        <button class="btn" type="button" @click="exportRows">导出廊桥调度清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button class="link" type="button" @click="openDetail(row)">详情</button>
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无廊桥调度数据，可先登记廊桥</td>
        </tr>
      </tbody>
    </table>

    <div v-if="detail" class="detail-panel">
      <header class="detail-head">
        <strong>廊桥详情 · {{ detail['廊桥编号'] }}</strong>
        <button class="link" type="button" @click="closeDetail">关闭</button>
      </header>
      <table class="data-table">
        <tbody>
          <tr v-for="item in detailRows" :key="item.label">
            <th>{{ item.label }}</th>
            <td :class="{ 'detail-status': item.label === '当前状态' }">{{ item.value }}</td>
          </tr>
          <tr>
            <th>关联机位占用结论</th>
            <td>{{ occupancyText }}</td>
          </tr>
          <tr>
            <th>故障停用记录</th>
            <td :class="{ 'error-text': detail.abnormal }">
              {{ detail.abnormal ? '存在故障停用记录' : '无' }}
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <footer class="page-foot">
      <span>共 {{ total }} 条廊桥调度记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  getEntry,
  linkedStandOf,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import { useSessionStore } from '@/stores/session'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('bridge')
const store = useSessionStore()
const columns = ["廊桥编号", "所属机位", "对接机型", "调度人员", "计划对接", "实际对接", "脱离时间", "廊桥状态"]
const actions = ["安排对接", "确认脱离", "停用报修"]
const statuses = ["待对接", "已对接", "已脱离", "故障停用"]
const stats = [{"label": "待对接廊桥", "value": 0}, {"label": "已对接廊桥", "value": 0}, {"label": "故障廊桥", "value": 0}]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const detailId = ref<number | null>(null)
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

// 详情不做本地快照，始终从台账读取规范记录，保证和列表、机位占用结论一致。
const detail = computed<EntryRow | null>(() =>
  detailId.value === null ? null : getEntry(meta.key, detailId.value),
)

const detailRows = computed(() => {
  if (!detail.value) {
    return []
  }
  const row = detail.value
  return [
    ...meta.fields.map((field) => ({ label: field, value: String(row[field] ?? '—') })),
    { label: '当前状态', value: String(row.status) },
  ]
})

// 占用结论直接来自机位分配台账，解除后结论同步变为已释放。
const occupancyText = computed(() => {
  if (!detail.value) {
    return ''
  }
  const linked = linkedStandOf(detail.value)
  if (!linked) {
    return '未匹配到机位分配台账'
  }
  return `机位 ${linked.stand['机位编号']}：${linked.occupancy}`
})

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '廊桥登记入口尚未接入审批流'
}

function openDetail(row: EntryRow) {
  detailId.value = Number(row.id)
  errorMessage.value = ''
}

function closeDetail() {
  detailId.value = null
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action, {
    operator: store.operator,
    role: store.role,
  })
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '廊桥调度列表读取失败'
  }
}

onMounted(reload)
</script>
