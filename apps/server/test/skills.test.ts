import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { loadSkillHints, renderSkillHints } from '../src/agent-tools.ts'

async function makeKb() {
  return mkdtemp(path.join(tmpdir(), 'ke-skb-'))
}

test('loadSkillHints：扫描 skills/*/SKILL.md 的 name/description（渐进披露启动级）', async () => {
  const kbRoot = await makeKb()
  await mkdir(path.join(kbRoot, 'skills', 'zettelkasten'), { recursive: true })
  await mkdir(path.join(kbRoot, 'skills', 'paper-review'), { recursive: true })
  await writeFile(
    path.join(kbRoot, 'skills', 'zettelkasten', 'SKILL.md'),
    '---\nname: 卡片盒笔记法\ndescription: 卢曼卡片盒的原子化与双向链接实践方法论\n---\n# 全文（不注入）\n',
  )
  await writeFile(
    path.join(kbRoot, 'skills', 'paper-review', 'SKILL.md'),
    '---\nname: 论文精读\ndescription: 三遍读法：框架→细节→批判\n---\n正文\n',
  )

  const hints = await loadSkillHints(kbRoot)
  assert.equal(hints.length, 2)
  assert.ok(hints.some((h) => h.name === '卡片盒笔记法' && h.dir === 'zettelkasten'))
  assert.ok(hints.some((h) => h.name === '论文精读'))
})

test('loadSkillHints：坏文件/缺字段/隐藏目录安全跳过；无 skills/ 返回空', async () => {
  const kbRoot = await makeKb()
  assert.deepEqual(await loadSkillHints(kbRoot), [])

  await mkdir(path.join(kbRoot, 'skills', 'bad'), { recursive: true })
  await mkdir(path.join(kbRoot, 'skills', '.hidden'), { recursive: true })
  await mkdir(path.join(kbRoot, 'skills', 'no-fm'), { recursive: true })
  await mkdir(path.join(kbRoot, 'skills', 'partial'), { recursive: true })
  // 坏 YAML（parsePage 容错返回空 fm 或抛错——两者都该安全跳过）
  await writeFile(path.join(kbRoot, 'skills', 'bad', 'SKILL.md'), '::: 不是 frontmatter')
  // 隐藏目录有完整文件也不进
  await writeFile(path.join(kbRoot, 'skills', '.hidden', 'SKILL.md'), '---\nname: x\ndescription: y\n---\n')
  // 缺 SKILL.md
  // 缺 description
  await writeFile(path.join(kbRoot, 'skills', 'partial', 'SKILL.md'), '---\nname: 只有名字\n---\n')

  const hints = await loadSkillHints(kbRoot)
  assert.equal(hints.length, 0)
})

test('renderSkillHints：空返回空串；非空拼启动级提示', () => {
  assert.equal(renderSkillHints([]), '')
  const out = renderSkillHints([
    { dir: 'a', name: '卡片盒笔记法', description: '方法论' },
    { dir: 'b', name: '论文精读', description: '三遍读法' },
  ])
  assert.ok(out.includes('可用技能'))
  assert.ok(out.includes('- 卡片盒笔记法：方法论'))
  assert.ok(out.includes('- 论文精读：三遍读法'))
})
