import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { beginTask, finishTask, listTasks, readTask } from '../src/workbench.ts'

async function makeData() {
  return mkdtemp(path.join(tmpdir(), 'ke-wb-'))
}

const TRACE = [
  { tool: 'search_kb', args: { q: '卡片盒' }, resultPreview: '命中 3 页', isError: false, ms: 12 },
  { tool: 'read_page', args: { path: 'wiki/concepts/卡片盒.md' }, resultPreview: '正文前 200 字…', isError: false, ms: 5 },
  { tool: 'web_search', args: { query: 'zettelkasten' }, resultPreview: '联网结果…', isError: false, ms: 340 },
]

test('begin → running 态落盘（崩溃留痕可见）', async () => {
  const dataRoot = await makeData()
  const id = await beginTask(dataRoot, { question: '卡片盒笔记法是什么？', toolCount: 4 })
  assert.match(id, /^tq-/)

  const raw = await readFile(path.join(dataRoot, 'tasks', `${id}.md`), 'utf8')
  assert.ok(raw.includes('status: running'))
  assert.ok(raw.includes('卡片盒笔记法是什么？'))
  assert.ok(raw.includes('## 背景与目标'))
  assert.ok(raw.includes('## 探索链路'))

  // 列表能读到 running 态
  const list = await listTasks(dataRoot)
  assert.equal(list.length, 1)
  assert.equal(list[0]!.status, 'running')
  assert.equal(list[0]!.toolCount, 4)
})

test('finishTask：done 终态 + 四节正文完整', async () => {
  const dataRoot = await makeData()
  const id = await beginTask(dataRoot, { question: 'Zettelkasten 的核心原则？', toolCount: 4 })
  const t = await finishTask(dataRoot, id, {
    status: 'done',
    question: 'Zettelkasten 的核心原则？',
    toolCount: 4,
    startedAt: new Date(Date.now() - 5000).toISOString(),
    trace: TRACE,
    answer: '核心是原子化与双向链接，见 [[卡片盒笔记法]]。',
    turns: 3,
    steps: 3,
    truncated: false,
    tokens: { input: 4200, output: 380 },
  })
  assert.equal(t.status, 'done')
  assert.equal(t.steps, 3)
  assert.ok(t.finishedAt)

  // 详情读回：frontmatter + 四节
  const detail = await readTask(dataRoot, id)
  assert.equal(detail!.status, 'done')
  assert.equal(detail!.tokens!.input, 4200)
  const body = detail!.body
  assert.ok(body.includes('## 背景与目标'))
  assert.ok(body.includes('> Zettelkasten 的核心原则？'))
  // 探索链路：三步只读工具全部进「探索」节
  assert.ok(body.includes('`search_kb`'))
  assert.ok(body.includes('命中 3 页'))
  assert.ok(body.includes('`web_search`'))
  // 执行链路：无写操作 → 阶段 A 围栏说明
  assert.ok(body.includes('## 执行链路'))
  assert.ok(body.includes('阶段 A'))
  // 结果节含回答与 token 统计
  assert.ok(body.includes('## 结果与迭代'))
  assert.ok(body.includes('[[卡片盒笔记法]]'))
  assert.ok(body.includes('4200/380'))
})

test('finishTask：error 终态带失败原因', async () => {
  const dataRoot = await makeData()
  const id = await beginTask(dataRoot, { question: '会失败的问题', toolCount: 2 })
  await finishTask(dataRoot, id, {
    status: 'error',
    question: '会失败的问题',
    toolCount: 2,
    startedAt: new Date().toISOString(),
    trace: [],
    answer: '',
    turns: 0,
    steps: 0,
    truncated: false,
    tokens: null,
    error: 'LLM 路由未配置',
  })
  const t = await readTask(dataRoot, id)
  assert.equal(t!.status, 'error')
  assert.ok(t!.body.includes('❌ 任务失败：LLM 路由未配置'))
})

test('listTasks：新在前、多任务排序；readTask 不存在返回 null', async () => {
  const dataRoot = await makeData()
  const a = await beginTask(dataRoot, { question: 'A 问题', toolCount: 1 })
  // 保证文件名排序（时间基 36 进制单调）
  await new Promise((r) => setTimeout(r, 1100))
  const b = await beginTask(dataRoot, { question: 'B 问题', toolCount: 1 })
  await finishTask(dataRoot, a, {
    status: 'done', question: 'A 问题', toolCount: 1, startedAt: '', trace: [],
    answer: 'a', turns: 1, steps: 0, truncated: false, tokens: null,
  })
  const list = await listTasks(dataRoot)
  assert.equal(list.length, 2)
  assert.equal(list[0]!.taskId, b) // 文件名倒序 = 新在前

  assert.equal(await readTask(dataRoot, 'nope'), null)
  await assert.rejects(readTask(dataRoot, '../etc/passwd'), /非法任务 ID/)
})

test('空 dataRoot：listTasks 返回空数组', async () => {
  const dataRoot = await makeData()
  assert.deepEqual(await listTasks(dataRoot), [])
})

test('写操作工具进「执行链路」节（闸门留痕槽位）', async () => {
  const dataRoot = await makeData()
  const id = await beginTask(dataRoot, { question: 'q', toolCount: 3 })
  const t = await finishTask(dataRoot, id, {
    status: 'done', question: 'q', toolCount: 3, startedAt: '',
    trace: [
      { tool: 'search_kb', args: { q: 'x' }, resultPreview: '命中', isError: false, ms: 1 },
      { tool: 'apply_edit', args: { path: 'wiki/a.md' }, resultPreview: '走审核闸门', isError: false, ms: 30 },
    ],
    answer: 'done', turns: 2, steps: 2, truncated: false, tokens: null,
  })
  const explorePart = t.body.split('## 执行链路')[0]!
  const execPart = t.body.split('## 执行链路')[1]!.split('## 结果与迭代')[0]!
  assert.ok(explorePart.includes('`search_kb`'))
  assert.ok(!explorePart.includes('`apply_edit`'))
  assert.ok(execPart.includes('`apply_edit`'))
  assert.ok(execPart.includes('✅'))
})
