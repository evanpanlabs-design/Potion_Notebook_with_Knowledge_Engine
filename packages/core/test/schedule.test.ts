import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  normalizeSchedule,
  computeNextDue,
  decideCatchup,
  describeSchedule,
  describeRelative,
  CATCHUP_WINDOW_MS,
} from '../src/schedule.ts'

// ---- normalizeSchedule：宽容解析 ----

test('normalizeSchedule 解析 daily 且补零（"7:5" → "07:05"）', () => {
  assert.deepEqual(normalizeSchedule({ type: 'daily', at: '7:5' }), { type: 'daily', at: '07:05' })
})

test('normalizeSchedule 接受标准 HH:MM', () => {
  assert.deepEqual(normalizeSchedule({ type: 'daily', at: '23:59' }), { type: 'daily', at: '23:59' })
})

test('normalizeSchedule 拒绝越界时分与畸形输入', () => {
  assert.equal(normalizeSchedule({ type: 'daily', at: '24:00' }), null)
  assert.equal(normalizeSchedule({ type: 'daily', at: '07:60' }), null)
  assert.equal(normalizeSchedule({ type: 'daily', at: '7点' }), null)
  assert.equal(normalizeSchedule({ type: 'daily' }), null)
  assert.equal(normalizeSchedule(null), null)
  assert.equal(normalizeSchedule('daily 7:00'), null)
  assert.equal(normalizeSchedule({ type: 'weekly', at: '07:00' }), null)
})

test('normalizeSchedule interval 四舍五入且钳制范围', () => {
  assert.deepEqual(normalizeSchedule({ type: 'interval', hours: 6 }), { type: 'interval', hours: 6 })
  assert.deepEqual(normalizeSchedule({ type: 'interval', hours: 5.4 }), { type: 'interval', hours: 5 })
  assert.equal(normalizeSchedule({ type: 'interval', hours: 0 }), null)
  assert.equal(normalizeSchedule({ type: 'interval', hours: 24 * 30 + 1 }), null)
  assert.equal(normalizeSchedule({ type: 'interval', hours: 'abc' }), null)
})

// ---- computeNextDue：daily ----

test('computeNextDue daily：当日时刻未过取当日，已过取明日', () => {
  const now = new Date('2026-09-30T10:00:00')
  const a = computeNextDue({ type: 'daily', at: '07:00' }, now) // 已过 7 点 → 明天
  assert.equal(a.getTime(), new Date('2026-10-01T07:00:00').getTime())
  const b = computeNextDue({ type: 'daily', at: '23:30' }, now) // 未到 23:30 → 当日
  assert.equal(b.getTime(), new Date('2026-09-30T23:30:00').getTime())
})

test('computeNextDue daily：恰好等于当前时刻算已过（严格晚于 from）', () => {
  const now = new Date('2026-09-30T07:00:00')
  const a = computeNextDue({ type: 'daily', at: '07:00' }, now)
  assert.equal(a.getTime(), new Date('2026-10-01T07:00:00').getTime())
})

test('computeNextDue daily：跨月推进', () => {
  const now = new Date('2026-09-30T23:59:00')
  const a = computeNextDue({ type: 'daily', at: '00:05' }, now)
  assert.equal(a.getTime(), new Date('2026-10-01T00:05:00').getTime())
})

// ---- computeNextDue：interval 锚点对齐 ----

test('computeNextDue interval：锚点对齐取下一个未来倍数', () => {
  const anchor = new Date('2026-09-30T00:00:00')
  const from = new Date('2026-09-30T13:00:00') // 13h → k = floor(13/6)+1 = 3 → 18:00
  const a = computeNextDue({ type: 'interval', hours: 6 }, from, anchor)
  assert.equal(a.getTime(), new Date('2026-09-30T18:00:00').getTime())
})

test('computeNextDue interval：from 恰在锚点倍数上 → 推一个整周期', () => {
  const anchor = new Date('2026-09-30T00:00:00')
  const from = new Date('2026-09-30T12:00:00') // 12h = 2×6h → k = 3 → 18:00
  const a = computeNextDue({ type: 'interval', hours: 6 }, from, anchor)
  assert.equal(a.getTime(), new Date('2026-09-30T18:00:00').getTime())
})

test('computeNextDue interval：缺省锚点 = from（创建即计算场景）', () => {
  const from = new Date('2026-09-30T10:30:00')
  const a = computeNextDue({ type: 'interval', hours: 2 }, from)
  assert.equal(a.getTime(), new Date('2026-09-30T12:30:00').getTime())
})

// ---- decideCatchup：24h 补偿边界 ----

test('decideCatchup：错过不足 24h 补做', () => {
  const due = 1_000_000
  assert.equal(decideCatchup(due, due + 1), 'run')
  assert.equal(decideCatchup(due, due + CATCHUP_WINDOW_MS - 1), 'run')
})

test('decideCatchup：错过 ≥24h 放弃', () => {
  const due = 1_000_000
  assert.equal(decideCatchup(due, due + CATCHUP_WINDOW_MS), 'skip')
  assert.equal(decideCatchup(due, due + 3 * CATCHUP_WINDOW_MS), 'skip')
})

test('decideCatchup：未到期（未来时刻）不触发补偿', () => {
  const due = 1_000_000
  assert.equal(decideCatchup(due, due - 1), 'run') // 调用方先判 nextDue <= now 才进来
})

// ---- 描述函数 ----

test('describeSchedule 人话输出', () => {
  assert.equal(describeSchedule({ type: 'daily', at: '07:00' }), '每天 07:00')
  assert.equal(describeSchedule({ type: 'interval', hours: 6 }), '每 6 小时')
})

test('describeRelative 过去/将来与分档格式', () => {
  const now = Date.parse('2026-09-30T12:00:00')
  assert.equal(describeRelative('2026-09-30T12:00:10', now), '不到 1 分钟后')
  assert.equal(describeRelative('2026-09-30T11:57:00', now), '3 分钟前')
  assert.equal(describeRelative('2026-09-30T15:00:00', now), '3 小时后')
  assert.equal(describeRelative('2026-09-28T12:00:00', now), '2 天前')
})
