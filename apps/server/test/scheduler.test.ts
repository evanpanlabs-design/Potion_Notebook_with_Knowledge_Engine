import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { startScheduler, type TaskRunner } from '../src/scheduler.ts'

/** 场景脚手架：临时 data/kb 目录 + 记录调用的 fake runner + 大扫描间隔（不干扰手动 sweep）
 *  kbRoot 必须也用临时目录——skipped 路径会往 kbRoot/bulletins/ 发 AI 便利贴 */
async function makeFixture(runner?: TaskRunner) {
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'ke-sched-'))
  const kbRoot = await mkdtemp(path.join(tmpdir(), 'ke-schedkb-'))
  const calls: { id: string; manual: boolean }[] = []
  const r: TaskRunner =
    runner ??
    (async (task, ctx) => {
      calls.push({ id: task.id, manual: ctx.manual })
      return { note: 'fake ok', artifact: 'inbox/fake.md' }
    })
  const scheduler = startScheduler({
    dataRoot,
    kbRoot,
    runners: new Map([['digest', r]]),
    scanMs: 60 * 60 * 1000, // 1 小时：测试期间 interval 不会自己触发
  })
  return { dataRoot, kbRoot, calls, scheduler }
}

/** 直接把任务（数组或单条）写进 tasks.json（模拟历史遗留状态），绕过 create() */
async function seedTask(dataRoot: string, task: object | object[]) {
  const tasks = Array.isArray(task) ? task : [task]
  await writeFile(path.join(dataRoot, 'tasks.json'), JSON.stringify({ tasks }, null, 2))
}

/** 直接改任务字段（store 无此 API，测试用重写文件） */
async function patchTask(dataRoot: string, id: string, patch: Record<string, unknown>) {
  const raw = JSON.parse(await readFile(path.join(dataRoot, 'tasks.json'), 'utf8')) as { tasks: any[] }
  const tasks = raw.tasks.map((t) => (t.id === id ? { ...t, ...patch } : t))
  await seedTask(dataRoot, tasks)
}

const now = () => new Date()

test('到点任务被 sweep 触发执行并推进 nextDue', async () => {
  const { dataRoot, calls, scheduler } = await makeFixture()
  try {
    // interval 1h，nextDue 已过期 5 秒 → due 触发（过期 < 60s 算准点而非补做）
    const t0 = now()
    const past = new Date(t0.getTime() - 5_000).toISOString()
    await seedTask(dataRoot, {
      id: 't-due', kind: 'digest', title: 'AI 资讯', topic: 'AI',
      schedule: { type: 'interval', hours: 1 }, enabled: true,
      createdAt: new Date(t0.getTime() - 2 * 3600_000).toISOString(),
      lastRunAt: null, nextDue: past, history: [],
    })
    const { ran, skipped } = await scheduler.sweepOnce()
    assert.deepEqual(ran, ['t-due'])
    assert.deepEqual(skipped, [])
    // execute 是异步的：等 runner 调用与落盘
    await waitFor(async () => (await scheduler.store.get('t-due'))?.history.length === 1)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].manual, false)
    const t = await scheduler.store.get('t-due')
    assert.equal(t?.history[0].outcome, 'ok') // 1 分钟内 → due 而非 caught-up
    assert.ok(t?.lastRunAt)
    // nextDue 推进到严格未来
    assert.ok(t && Date.parse(t.nextDue) > Date.now())
  } finally {
    scheduler.stop()
  }
})

test('错过 < 24h 的任务补做（caught-up）', async () => {
  const { dataRoot, calls, scheduler } = await makeFixture()
  try {
    const t0 = now()
    await seedTask(dataRoot, {
      id: 't-catchup', kind: 'digest', title: 'AI 资讯', topic: 'AI',
      schedule: { type: 'interval', hours: 12 }, enabled: true,
      createdAt: new Date(t0.getTime() - 26 * 3600_000).toISOString(),
      lastRunAt: null,
      nextDue: new Date(t0.getTime() - 5 * 3600_000).toISOString(), // 错过 5h
      history: [],
    })
    const { ran } = await scheduler.sweepOnce()
    assert.deepEqual(ran, ['t-catchup'])
    await waitFor(async () => (await scheduler.store.get('t-catchup'))?.history.length === 1)
    assert.equal(calls.length, 1)
    const t = await scheduler.store.get('t-catchup')
    assert.equal(t?.history[0].outcome, 'caught-up')
  } finally {
    scheduler.stop()
  }
})

test('错过 ≥ 24h 的任务放弃（skipped）且不执行 runner', async () => {
  const { dataRoot, calls, scheduler } = await makeFixture()
  try {
    const t0 = now()
    const due = new Date(t0.getTime() - 30 * 3600_000).toISOString() // 错过 30h
    await seedTask(dataRoot, {
      id: 't-skip', kind: 'digest', title: 'AI 资讯', topic: 'AI',
      schedule: { type: 'daily', at: '07:00' }, enabled: true,
      createdAt: new Date(t0.getTime() - 3 * 24 * 3600_000).toISOString(),
      lastRunAt: null, nextDue: due, history: [],
    })
    const { ran, skipped } = await scheduler.sweepOnce()
    assert.deepEqual(ran, [])
    assert.deepEqual(skipped, ['t-skip'])
    assert.equal(calls.length, 0) // 不执行
    const t = await scheduler.store.get('t-skip')
    assert.equal(t?.history[0].outcome, 'skipped')
    assert.ok(t?.history[0].note?.includes('放弃'))
    // nextDue 已推进到未来（不会下轮再放弃一次）
    assert.ok(t && Date.parse(t.nextDue) > Date.now())
  } finally {
    scheduler.stop()
  }
})

test('未到期与已停用任务不被触发', async () => {
  const { dataRoot, calls, scheduler } = await makeFixture()
  try {
    const t0 = now()
    await seedTask(dataRoot, [
      {
        id: 't-future', kind: 'digest', title: 'A', topic: 'a',
        schedule: { type: 'interval', hours: 1 }, enabled: true,
        createdAt: t0.toISOString(),
        lastRunAt: null, nextDue: new Date(t0.getTime() + 3600_000).toISOString(), history: [],
      },
      {
        id: 't-off', kind: 'digest', title: 'B', topic: 'b',
        schedule: { type: 'daily', at: '07:00' }, enabled: false,
        createdAt: t0.toISOString(),
        lastRunAt: null, nextDue: new Date(t0.getTime() - 3600_000).toISOString(), history: [],
      },
    ])
    const { ran, skipped } = await scheduler.sweepOnce()
    assert.deepEqual(ran, [])
    assert.deepEqual(skipped, [])
    assert.equal(calls.length, 0)
  } finally {
    scheduler.stop()
  }
})

test('runNow 手动触发：outcome=manual', async () => {
  const { scheduler } = await makeFixture()
  try {
    const task = await scheduler.store.create({
      kind: 'digest', title: 'AI 资讯', topic: 'AI', schedule: { type: 'daily', at: '07:00' },
    })
    const rec = await scheduler.runNow(task.id)
    assert.equal(rec.outcome, 'manual')
    const t = await scheduler.store.get(task.id)
    assert.equal(t?.history[0].outcome, 'manual')
    assert.ok(t && Date.parse(t.nextDue) > Date.now())
    // 不存在的任务报错
    await assert.rejects(scheduler.runNow('t-nope'), /任务不存在/)
  } finally {
    scheduler.stop()
  }
})

test('runner 抛错：outcome=error，nextDue 仍推进（下轮重试）', async () => {
  const { dataRoot, scheduler } = await makeFixture(async () => {
    throw new Error('boom')
  })
  try {
    const t0 = now()
    await seedTask(dataRoot, {
      id: 't-err', kind: 'digest', title: 'E', topic: 'e',
      schedule: { type: 'interval', hours: 1 }, enabled: true,
      createdAt: new Date(t0.getTime() - 2 * 3600_000).toISOString(),
      lastRunAt: null, nextDue: new Date(t0.getTime() - 60_000).toISOString(), history: [],
    })
    await scheduler.sweepOnce()
    await waitFor(async () => (await scheduler.store.get('t-err'))?.history.length === 1)
    const t = await scheduler.store.get('t-err')
    assert.equal(t?.history[0].outcome, 'error')
    assert.ok(t?.history[0].note?.includes('boom'))
    assert.ok(t && Date.parse(t.nextDue) > Date.now())
  } finally {
    scheduler.stop()
  }
})

test('create 落盘 tasks.json 且恢复持久化任务（跨“重启”）', async () => {
  const { dataRoot, scheduler } = await makeFixture()
  scheduler.stop()
  const task = await scheduler.store.create({
    kind: 'digest', title: '持久化', topic: 'AI', schedule: { type: 'daily', at: '07:00' },
  })
  const raw = JSON.parse(await readFile(path.join(dataRoot, 'tasks.json'), 'utf8'))
  assert.equal(raw.tasks.length, 1)
  assert.equal(raw.tasks[0].id, task.id)
  // 模拟重启：同一 dataRoot 起新 scheduler（nextDue 未到，不触发）
  const calls2: string[] = []
  const scheduler2 = startScheduler({
    dataRoot,
    kbRoot: dataRoot, // 重启场景下 kbRoot 无关紧要（不会触发 skipped 发帖）
    runners: new Map([['digest', async (t) => { calls2.push(t.id); return {} }]]),
    scanMs: 60 * 60 * 1000,
  })
  try {
    const ts = await scheduler2.store.list()
    assert.equal(ts.length, 1)
    assert.equal(ts[0].id, task.id)
    assert.deepEqual(calls2, []) // 启动即扫一轮，但 nextDue 在未来 → 不触发
  } finally {
    scheduler2.stop()
  }
})

test('setEnabled 停用后不被触发，恢复时重算 nextDue 不补做', async () => {
  const { dataRoot, calls, scheduler } = await makeFixture()
  try {
    const task = await scheduler.store.create({
      kind: 'digest', title: '开关', topic: 'AI', schedule: { type: 'interval', hours: 1 },
    })
    const off = await scheduler.store.setEnabled(task.id, false)
    assert.equal(off?.enabled, false)
    // 把 nextDue 改到过去（模拟停用期间错过），sweep 仍不触发
    await patchTask(dataRoot, task.id, { nextDue: new Date(Date.now() - 3 * 3600_000).toISOString() })
    const { ran, skipped } = await scheduler.sweepOnce()
    assert.deepEqual(ran, [])
    assert.deepEqual(skipped, [])
    assert.equal(calls.length, 0)
    // 恢复启用：nextDue 重算到未来，不立刻补做
    const on = await scheduler.store.setEnabled(task.id, true)
    assert.equal(on?.enabled, true)
    assert.ok(on && Date.parse(on.nextDue) > Date.now())
    const r2 = await scheduler.sweepOnce()
    assert.deepEqual(r2.ran, [])
  } finally {
    scheduler.stop()
  }
})

// ---- 工具 ----

/** 等条件成立（轮询 5ms，最多 2s），失败抛错 */
async function waitFor(cond: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 2000
  while (Date.now() < deadline) {
    if (await cond()) return
    await new Promise((r) => setTimeout(r, 5))
  }
  throw new Error('waitFor 超时')
}
