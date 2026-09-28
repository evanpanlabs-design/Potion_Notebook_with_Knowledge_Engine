import Fastify from 'fastify'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

/**
 * 最小 server 骨架（D1）：仅实现 health 与只读 pages 读取。
 * API 契约见 ARCHITECTURE §8；写入类端点全部等 gate executor（D2+）落地。
 * 仅绑定 127.0.0.1，不做鉴权（本地单用户）。
 */

const KB_ROOT = process.env.KNOWLEDGE_BASE ?? path.resolve('data/my-wiki')

const app = Fastify({ logger: false })

app.get('/api/v1/health', async () => ({ ok: true, version: '0.1.0' }))

/** 只读页面读取：防路径穿越，仅允许 .md */
app.get('/api/v1/pages/*', async (req, reply) => {
  const rel = (req.params as { '*': string })['*']
  if (!rel.endsWith('.md')) {
    return reply.code(400).send({ error: '只允许读取 .md 页面' })
  }
  const abs = path.normalize(path.join(KB_ROOT, rel))
  if (!abs.startsWith(path.resolve(KB_ROOT) + path.sep)) {
    return reply.code(403).send({ error: '路径越界' })
  }
  try {
    const text = await readFile(abs, 'utf8')
    return { path: rel, content: text }
  } catch {
    return reply.code(404).send({ error: '页面不存在' })
  }
})

const port = Number(process.env.PORT ?? 3100)
app.listen({ port, host: '127.0.0.1' }).then(() => {
  console.log(`knowledge-engine server listening on http://127.0.0.1:${port} (KB: ${KB_ROOT})`)
})
