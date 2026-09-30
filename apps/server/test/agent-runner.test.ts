import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { createAgentRunner } from '../src/agent-runner.ts'
import { parsePage } from '@ke/core'

/** fake LLM 路由：单轮流式文本（不调工具 → loop 第一轮即出最终答案） */
function fakeRouting(answer) {
  return {
    streamRaw: async function* () {
      yield { type: 'text_delta', delta: answer }
      yield {
        type: 'done',
        message: {
          content: [{ type: 'text', text: answer }],
          usage: { input: 100, output: 50 },
        },
      }
    },
  }
}

function makeTask(patch = {}) {
  return {
    id: 't-agent-1',
    kind: 'agent',
    title: '知识库周报',
    topic: '周报',
    prompt: '总结本周 log.md 的动态，写一份 200 字周报',
    schedule: { type: 'daily', at: '09:00' },
    enabled: true,
    createdAt: new Date().toISOString(),
    lastRunAt: null,
    nextDue: new Date().toISOString(),
    history: [],
    ...patch,
  }
}

async function makeEnv() {
  const kbRoot = await mkdtemp(path.join(tmpdir(), 'ke-kb-'))
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'ke-data-'))
  await mkdir(path.join(kbRoot, 'inbox'), { recursive: true })
  return {
    kbRoot,
    dataRoot,
    runner: createAgentRunner({ kbRoot, dataRoot, routing: fakeRouting('本周新增 3 页 wiki。') }),
  }
}

test('agent runner：唤醒 loop → 产物落 inbox（bulletin fm）+ note 带轨迹摘要', async () => {
  const { kbRoot, dataRoot, runner } = await makeEnv()
  const r = await runner(makeTask(), { manual: true })

  assert.ok(r.artifact && r.artifact.startsWith('inbox/agent-'))
  assert.ok(r.note && r.note.includes('agent') && r.note.includes('1 轮'))

  const raw = await readFile(path.join(kbRoot, r.artifact), 'utf8')
  const { fm, body } = parsePage(raw)
  assert.equal(fm['type'], 'bulletin')
  assert.equal(fm['runner'], 'agent')
  assert.equal(fm['task'], 't-agent-1')
  assert.equal(fm['truncated'], false)
  assert.ok(body.includes('本周新增 3 页 wiki'))
  assert.ok(body.includes('执行轨迹')) // 轨迹摘要段

  // workbench 全轨迹落盘（data/tasks/ 下应有 md 文件）
  const wbFiles = await readdir(path.join(dataRoot, 'tasks'))
  assert.ok(wbFiles.some((f) => f.endsWith('.md')))
})

test('agent runner：缺 prompt 拒跑（任务记 error）', async () => {
  const { runner } = await makeEnv()
  const bad = makeTask({ prompt: undefined })
  await assert.rejects(runner(bad, { manual: false }), /缺少 prompt/)
})

test('agent runner：LLM 失败 → 抛错（调度器记 error，不写半成品产物）', async () => {
  const kbRoot = await mkdtemp(path.join(tmpdir(), 'ke-kb-'))
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'ke-data-'))
  await mkdir(path.join(kbRoot, 'inbox'), { recursive: true })
  const badRouting = {
    streamRaw: async function* () {
      throw new Error('LLM down')
    },
  }
  const runner = createAgentRunner({ kbRoot, dataRoot, routing: badRouting })
  await assert.rejects(runner(makeTask({ id: 't-agent-2', title: '会失败的任务' }), { manual: false }), /LLM down/)
})
