// Pure-logic tests for the HTML-export markdown preprocessing
// (extractBlock / imageTag / replaceAsync etc.). No Obsidian dependency.
import assert from 'assert'

// ---- copies of the pure functions from src/rendering/screenshot.ts ----

const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp']

const imageWidthNumber = (param, globalWidth = 300) => {
  const match = param?.match(/^(\d+)/)
  return match ? match[1] : String(globalWidth)
}

const isImageLink = (link) => {
  const ext = link.split('.').pop()?.toLowerCase()
  return !!ext && IMAGE_EXTENSIONS.includes(ext)
}

const splitSubpath = (link) => {
  const hashIndex = link.indexOf('#')
  if (hashIndex === -1) return [link, '']
  return [link.slice(0, hashIndex), link.slice(hashIndex + 1)]
}

function extractBlock(content, subpath) {
  if (!subpath) return content.trim()
  if (subpath.startsWith('^')) {
    const id = subpath.slice(1)
    const escapedId = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const blocks = content.split(/\n\s*\n/)
    for (const block of blocks) {
      const lines = block.split('\n')
      let lastIndex = lines.length - 1
      while (lastIndex >= 0 && lines[lastIndex].trim() === '') lastIndex--
      if (lastIndex < 0) continue
      const last = lines[lastIndex]
      const inline = last.match(new RegExp(`^(.*?)\\s*\\^${escapedId}\\s*$`))
      if (inline) {
        lines[lastIndex] = inline[1].trimEnd()
        return lines.join('\n').trim()
      }
      if (last.trim() === `^${id}`) {
        lines.splice(lastIndex, 1)
        return lines.join('\n').trim()
      }
    }
    return null
  }
  const lines = content.split('\n')
  let start = -1
  let level = 0
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(#{1,6})\s+(.*?)\s*$/)
    if (m && m[2].trim() === subpath.trim()) { start = i; level = m[1].length; break }
  }
  if (start === -1) return null
  const out = [lines[start]]
  for (let i = start + 1; i < lines.length; i++) {
    const m = lines[i].match(/^(#{1,6})\s+/)
    if (m && m[1].length <= level) break
    out.push(lines[i])
  }
  return out.join('\n').trim()
}

async function replaceAsync(str, regex, replacer) {
  const matches = [...str.matchAll(regex)]
  const replacements = await Promise.all(matches.map(m => replacer(m)))
  let result = str
  for (let i = matches.length - 1; i >= 0; i--) {
    const m = matches[i]
    result = result.slice(0, m.index) + replacements[i] + result.slice(m.index + m[0].length)
  }
  return result
}

// ---- tests ----

// 1. imageWidthNumber: explicit width wins, else the global default
assert.strictEqual(imageWidthNumber(''), '300')
assert.strictEqual(imageWidthNumber('300'), '300')
assert.strictEqual(imageWidthNumber('300x200'), '300')
assert.strictEqual(imageWidthNumber('', 500), '500')
assert.strictEqual(imageWidthNumber('120', 500), '120')
console.log('✓ imageWidthNumber (width priority)')

// 2. isImageLink / splitSubpath
assert.ok(isImageLink('attachments/a.png'))
assert.ok(isImageLink('a.JPG'))
assert.ok(!isImageLink('note'))
assert.deepStrictEqual(splitSubpath('file'), ['file', ''])
assert.deepStrictEqual(splitSubpath('file#^abc'), ['file', '^abc'])
assert.deepStrictEqual(splitSubpath('file#Heading'), ['file', 'Heading'])
console.log('✓ isImageLink / splitSubpath')

// 3. extractBlock: block id
const doc = `# 标题

这是第一个块
包含两行 ^abc123

这是第二个块

## 小节

小节内容 ^block2
`
assert.strictEqual(extractBlock(doc, '^abc123'), '这是第一个块\n包含两行')
assert.strictEqual(extractBlock(doc, '^block2'), '小节内容')
console.log('✓ extractBlock (block ids)')

// 4. extractBlock: heading
const headingDoc = `# 总标题

## 二级标题

二级内容第一行

二级内容第二行

## 另一个标题

其他内容
`
assert.strictEqual(
  extractBlock(headingDoc, '二级标题'),
  '## 二级标题\n\n二级内容第一行\n\n二级内容第二行'
)
console.log('✓ extractBlock (headings)')

// 5. extractBlock: whole file
assert.strictEqual(extractBlock(doc, ''), doc.trim())
console.log('✓ extractBlock (whole file)')

// 6. replaceAsync with multiple matches
const result = await replaceAsync(
  'a [[x.png|300]] b [[y.png]] c [[note]] d',
  /(!?)\[\[([^\]]+)\]\]/g,
  async (m) => {
    const inner = m[2]
    const [link, ...params] = inner.split('|')
    if (isImageLink(link)) return `<img src="data:${link}" width="${imageWidthNumber(params.join('|'))}">`
    return `<a href="${link}">${link}</a>`
  }
)
assert.strictEqual(
  result,
  'a <img src="data:x.png" width="300"> b <img src="data:y.png" width="300"> c <a href="note">note</a> d'
)
console.log('✓ replaceAsync (multiple matches, mixed types)')

console.log('\nAll preprocessing logic tests passed ✅')
