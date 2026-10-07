// 数据层行为验证（纯 JS：用 TypeScript 自带转译器，不依赖 esbuild/rollup 原生二进制）。
// 覆盖：解除结论统一、机位联动释放、残留清空、故障痕迹保持、失败重试、越权拒绝、老数据迁移去重。
const fs = require('fs')
const path = require('path')
const assert = require('assert')
const ts = require('typescript')

const SRC = path.join(__dirname, 'src')

// 让 require 直接吃 .ts，并把 @/ 别名解析到 src。
require.extensions['.ts'] = function (module, filename) {
  const source = fs.readFileSync(filename, 'utf8')
  const out = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    fileName: filename,
  })
  module._compile(out.outputText, filename)
}
const Module = require('module')
const originalLoad = Module._load
Module._load = function (request, parent, isMain) {
  if (request.startsWith('@/')) {
    request = path.join(SRC, request.slice(2))
  }
  return originalLoad.call(this, request, parent, isMain)
}

const mem = new Map()
function installStorage() {
  globalThis.window = {
    localStorage: {
      getItem: (k) => (mem.has(k) ? mem.get(k) : null),
      setItem: (k, v) => {
        if (globalThis.__failNextWrite) {
          globalThis.__failNextWrite = false
          throw new Error('QuotaExceededError')
        }
        mem.set(k, String(v))
      },
    },
  }
  globalThis.localStorage = globalThis.window.localStorage
}

function freshService() {
  installStorage()
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(SRC)) delete require.cache[key]
  }
  return require(path.join(SRC, 'api', 'local-service.ts'))
}

function find(svc, key, id) {
  return svc.listEntries(key).items.find((r) => Number(r.id) === id)
}

;(async () => {
  const svc = freshService()

  // 1. 解除：镜像字段与 status 统一，pending 残留清空
  svc.runAction('bridge', 1, '安排对接')
  let b1 = find(svc, 'bridge', 1)
  assert.strictEqual(b1.status, '已对接')
  assert.strictEqual(b1['廊桥状态'], '已对接', '详情镜像应同步为已对接')
  assert.strictEqual(b1.pending, true)

  svc.runAction('bridge', 1, '确认脱离')
  b1 = find(svc, 'bridge', 1)
  assert.strictEqual(b1.status, '已脱离')
  assert.strictEqual(b1['廊桥状态'], '已脱离', '列表与详情结论必须一致')
  assert.strictEqual(b1.pending, false, '脱离后残留待处理标记要清空')
  assert.strictEqual(b1.abnormal, false, '正常脱离不能被记异常')

  // 2. 机位台账同步释放，且不产生重复条目
  const s1 = find(svc, 'stand', 1)
  assert.strictEqual(s1.status, '已释放')
  assert.strictEqual(s1['分配状态'], '已释放')
  assert.strictEqual(s1.pending, false)
  assert.strictEqual(svc.listEntries('stand').total, 4, '原位更新，不能多出记录')

  // 3. 越权回退（已脱离再安排对接）必须拒绝，原值保持
  const revert = svc.runAction('bridge', 1, '安排对接')
  assert.strictEqual(revert.ok, false)
  assert.strictEqual(find(svc, 'bridge', 1).status, '已脱离')

  // 4. 故障停用：从已对接报修，abnormal=true
  const r2 = svc.runAction('bridge', 2, '停用报修')
  assert.strictEqual(r2.ok, true)
  const b2 = find(svc, 'bridge', 2)
  assert.strictEqual(b2.status, '故障停用')
  assert.strictEqual(b2['廊桥状态'], '故障停用')
  assert.strictEqual(b2.abnormal, true)
  assert.strictEqual(b2.pending, false)

  // 5. 故障记录不允许任何正常流转，历史异常保持
  assert.deepStrictEqual(svc.availableActions('bridge', b2), [])
  const again = svc.runAction('bridge', 2, '安排对接')
  assert.strictEqual(again.ok, false)
  assert.strictEqual(find(svc, 'bridge', 2).abnormal, true, '故障停用记录不能丢失')

  // 6. 只读角色越权修改被拒绝，记录不动
  const before = JSON.stringify(find(svc, 'bridge', 2))
  const denied = svc.runAction('bridge', 2, '停用报修', {
    actor: { operator: '张三', role: '只读用户' },
  })
  assert.strictEqual(denied.ok, false)
  assert.strictEqual(JSON.stringify(find(svc, 'bridge', 2)), before)
  const deniedViewer = svc.runAction('stand', 1, '分配机位', {
    actor: { operator: '李四', role: 'viewer' },
  })
  assert.strictEqual(deniedViewer.ok, false)

  // 7. 写盘失败：内存保持原记录，重试从原记录继续并成功
  svc.resetModule('bridge')
  svc.resetModule('stand')
  assert.strictEqual(find(svc, 'bridge', 1).status, '待对接')
  globalThis.__failNextWrite = true
  const failed = svc.runAction('bridge', 1, '安排对接')
  assert.strictEqual(failed.ok, false)
  assert.strictEqual(find(svc, 'bridge', 1).status, '待对接', '失败后原记录保持')
  assert.strictEqual(find(svc, 'stand', 1).status, '空闲', '联动侧也不能半成品')
  const retried = svc.runAction('bridge', 1, '安排对接')
  assert.strictEqual(retried.ok, true)
  assert.strictEqual(find(svc, 'bridge', 1).status, '已对接')
  assert.strictEqual(find(svc, 'stand', 1).status, '占用中')
  assert.strictEqual(svc.listEntries('stand').total, 4, '重试不产生重复')

  // 8. 启动迁移：老格式脏数据（镜像陈旧、pending 残留、重复 id）被修正
  mem.clear()
  mem.set('airport-ground-handling:entries', JSON.stringify({
    bridge: [
      { id: 9, status: '已脱离', pending: true, abnormal: false, '廊桥状态': '已对接', '所属机位': 'STAN-0001' },
      { id: 9, status: '已脱离', pending: true, abnormal: false, '廊桥状态': '已对接', '所属机位': 'STAN-0001' },
    ],
  }))
  const svc2 = freshService()
  svc2.reconcileStorage()
  const rows = svc2.listEntries('bridge').items
  assert.strictEqual(rows.length, 1, '重复 id 去重，只保留首条')
  assert.strictEqual(rows[0].status, '已脱离')
  assert.strictEqual(rows[0]['廊桥状态'], '已脱离', '镜像字段迁移对齐')
  assert.strictEqual(rows[0].pending, false, '残留 pending 清空')

  // 9. 异常漏标的历史故障记录，迁移补齐 abnormal=true
  mem.clear()
  mem.set('airport-ground-handling:entries', JSON.stringify({
    bridge: [
      { id: 8, status: '故障停用', pending: true, abnormal: false, '廊桥状态': '故障停用', '所属机位': 'STAN-0002' },
    ],
  }))
  const svc3 = freshService()
  svc3.reconcileStorage()
  const broken = svc3.listEntries('bridge').items.find((r) => r.id === 8)
  assert.strictEqual(broken.abnormal, true, '历史故障标记补齐')
  assert.strictEqual(broken.pending, false)

  console.log('ALL ASSERTIONS PASSED')
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
