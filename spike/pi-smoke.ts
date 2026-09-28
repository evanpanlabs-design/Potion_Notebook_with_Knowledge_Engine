/**
 * M0 Spike（ROADMAP §1 验证点 1，压缩版）：pi 最小 agent 验证。
 * 全链路：读本地文件夹 → LLM 调用（pi-ai 自定义 OpenAI 兼容 provider）→ 受控写一个 md 文件。
 * 写入经过 @ke/core 校验链（无 key 也能跑前半段的 dry-run 模式）。
 *
 * 用法：
 *   真实模式  npm run spike:pi   （需 .env，见 .env.example）
 *   干跑模式  npm run spike:pi -- --dry   （无需任何 key，验证读文件夹+校验链+落盘格式）
 */
import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import process from 'node:process'

const SPIKE_DIR = path.resolve(import.meta.dirname, 'pi-spike-out')
const SAMPLE_DIR = path.resolve(import.meta.dirname, 'pi-spike-sample')

async function ensureSample(): Promise<string[]> {
  await mkdir(SAMPLE_DIR, { recursive: true })
  const f = path.join(SAMPLE_DIR, 'karpathy-llm-wiki.md')
  await writeFile(
    f,
    [
      '# 用 LLM 构建个人 Wiki',
      '',
      'Karpathy 提出的模式：把原始资料交给 LLM，让它生成并持续维护一个带引用的结构化 wiki。',
      '核心理念：人负责判断与策展，LLM 负责维护；每次操作记录进 log.md，可回滚。',
      '',
    ].join('\n'),
    'utf8',
  )
  return [f]
}

async function readFolder(): Promise<{ name: string; sha256: string; text: string }[]> {
  const files = await readdir(SAMPLE_DIR).then((ls) => ls.filter((f) => f.endsWith('.md')))
  const out = []
  for (const f of files) {
    const text = await readFile(path.join(SAMPLE_DIR, f), 'utf8')
    out.push({
      name: f,
      sha256: createHash('sha256').update(text).digest('hex'),
      text,
    })
  }
  return out
}

async function main() {
  const dry = process.argv.includes('--dry')
  console.log(`[spike] 模式：${dry ? 'dry-run（不调 LLM）' : 'real（调 LLM）'}`)

  // 1. 读本地文件夹
  await ensureSample()
  const files = await readFolder()
  console.log(`[spike] 1/4 读取文件夹成功：${files.map((f) => `${f.name} (sha256 ${f.sha256.slice(0, 8)}…)`).join(', ')}`)

  // 2. LLM 调用
  let summary: string
  let tokensUsed = { analysis: 0, generation: 0 }
  if (dry) {
    summary = '（dry-run 模拟输出）Karpathy 的 LLM Wiki 模式：LLM 维护、人策展、log 可回滚。'
    console.log('[spike] 2/4 跳过 LLM 调用（dry-run）')
  } else {
    const missing = ['LLM_BASE_URL', 'LLM_API_KEY', 'LLM_MODEL'].filter((k) => !process.env[k])
    if (missing.length > 0) {
      console.error(
        `[spike] 缺少环境变量：${missing.join(', ')}。请复制 .env.example 为 .env 填写后运行 npm run spike:pi（或通过 --env-file 加载）`,
      )
      process.exit(1)
    }
    const { createRouting, collectText } = await import('../packages/agent-tools/src/index.ts')
    const routing = createRouting({
      ingest: {
        baseUrl: process.env.LLM_BASE_URL!,
        apiKey: process.env.LLM_API_KEY!,
        model: process.env.LLM_MODEL!,
      },
      query: {
        baseUrl: process.env.LLM_BASE_URL!,
        apiKey: process.env.LLM_API_KEY!,
        model: process.env.LLM_MODEL!,
      },
    })
    const { text } = await collectText(
      routing.stream('ingest', '你是一个知识库摘要助手。用不超过两句话总结给定材料，不要编造。', [
        { role: 'user', text: files.map((f) => f.text).join('\n\n---\n\n') },
      ]),
    )
    summary = text.trim()
    console.log(`[spike] 2/4 LLM 调用成功：${summary.slice(0, 60)}…`)
  }

  // 3. 组装 wiki 页并过 @ke/core 校验链
  const { serializePage, validateProposal } = await import('@ke/core')
  const now = new Date().toISOString()
  const fm = {
    type: 'source',
    title: 'LLM Wiki 模式（spike）',
    source: 'karpathy-llm-wiki.md',
    sha256: files[0]!.sha256,
    ingested_at: now,
    tokens: tokensUsed,
  }
  const result = validateProposal(
    {
      path: 'wiki/sources/karpathy-llm-wiki.md',
      fm,
      body: summary,
      operation: 'create',
    },
    {
      existingPages: new Set<string>(),
      existingSources: new Set(['karpathy-llm-wiki.md']),
      reviewedPages: new Set<string>(),
      tagVocabulary: [],
    },
  )
  console.log(`[spike] 3/4 校验链结果：ok=${result.ok}${result.warnings.length ? ` warnings=${result.warnings.join('; ')}` : ''}`)
  if (!result.ok) {
    console.error(`[spike] 校验失败（这不该发生）：${result.errors.join('; ')}`)
    process.exit(1)
  }

  // 4. 受控写文件
  await mkdir(path.join(SPIKE_DIR, 'wiki', 'sources'), { recursive: true })
  const outPath = path.join(SPIKE_DIR, 'wiki', 'sources', 'karpathy-llm-wiki.md')
  await writeFile(outPath, serializePage(result.sanitized!.fm, `\n${result.sanitized!.body}\n`), 'utf8')
  console.log(`[spike] 4/4 受控写入成功：${outPath}`)
  console.log('[spike] ✅ M0 验证点 1 全链路通过（读文件夹 → LLM → 校验链 → 受控写文件）')
}

main().catch((e) => {
  console.error('[spike] 失败：', e)
  process.exit(1)
})
