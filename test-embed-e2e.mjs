// End-to-end test of the export markdown preprocessing with mocked Obsidian
// APIs, to locate why <mmng-embed> elements do not appear in exported HTML.
import assert from 'assert'

// ---------- mocked Obsidian runtime ----------
const mockVault = {
  'test.md': `# 测试文件

这是块内容 ^abc123

## 小节标题

小节内容
`,
  'sub/other.md': '# 另一个文件\n\n- 列表项 A\n- 列表项 B\n',
  'img.png': 'mock-image-bytes',
  // user's real style: nested paths with block ids
  '10-学习笔记/10-09_考公/资料分析/思维导图Block.md': `# 资料分析思维导图

混合比例线段法 ^s6et6l
`,
  '形式逻辑知识点先导.md': `# 形式逻辑

推出关系说明 ^tz8z37
`,
  '资料分析.md': `# 资料分析

## 除法

除法的内容
`,
}

const TFile = class TFile { constructor(path, extension) { this.path = path; this.extension = extension; this.basename = path.split('/').pop().replace(/\.md$/, '') } }

globalThis.app = {
  metadataCache: {
    getFirstLinkpathDest(linktext, sourcePath) {
      const candidates = [`${linktext}.md`, linktext]
      for (const p of Object.keys(mockVault)) {
        if (candidates.includes(p)) return new TFile(p, p.endsWith('.png') ? 'png' : 'md')
      }
      return null
    },
  },
  vault: {
    async cachedRead(file) { return mockVault[file.path] ?? '' },
  },
}

// Minimal markdown->HTML renderer standing in for MarkdownRenderer (the real
// one is Obsidian-internal; here we just need valid HTML output).
const MarkdownRenderer = {
  async renderMarkdown(markdown, el) {
    const lines = markdown.split('\n')
    const html = lines.map(l => {
      if (l.startsWith('#')) return `<h1>${l.replace(/^#+\s*/, '')}</h1>`
      if (l.startsWith('- ')) return `<ul><li>${l.slice(2)}</li></ul>`
      if (l.trim() === '') return ''
      return `<p>${l}</p>`
    }).join('')
    el.innerHTML = html
  },
}

const globalSettings = { htmlImageWidth: 300 }

// ---------- copied from src/rendering/screenshot.ts ----------
const SVG_NS = 'http://www.w3.org/2000/svg'
const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp']

const obsidianResolver = {
  async resolveImage(linktext, sourcePath) {
    const file = app.metadataCache.getFirstLinkpathDest(linktext, sourcePath)
    if (!file) return null
    return `data:image/png;base64,MOCK`
  },
  async readMarkdown(linktext, sourcePath) {
    const file = app.metadataCache.getFirstLinkpathDest(linktext, sourcePath)
    if (!file) return null
    return { content: await app.vault.cachedRead(file), path: file.path }
  },
}

const escapeHtml = (s) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const imageWidthNumber = (param) => {
  const match = param?.match(/^(\d+)/)
  return match ? match[1] : String(globalSettings.htmlImageWidth || 300)
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
    // Locate the line containing the block id, then expand to the block
    // around it (blank-line separated, or a whole fenced code block), and
    // strip the "^id" marker.
    const id = subpath.slice(1)
    const lines = content.split('\n')
    let idx = -1
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes(`^${id}`)) { idx = i; break }
    }
    if (idx === -1) return null
    // If the id sits at the end of a content line ("text ^id") the block
    // starts HERE (that line + its deeper-indented children), so do not
    // expand upwards. A standalone "^id" line marks the END of a block that
    // lives above it (e.g. a fenced code block), so expand upwards then.
    const isStandaloneId = lines[idx].trim() === `^${id}`
    let start = idx
    if (!isStandaloneId) {
      // block starts on the id line itself
      start = idx
    } else {
      // skip blank lines above the id line
      while (start > 0 && lines[start - 1].trim() === '') start--
      // if the block above the id is a fenced code block, include the whole fence
      if (start > 0 && /^```/.test(lines[start - 1].trim())) {
        let fence = 0
        let p = start - 1
        while (p >= 0) {
          if (/^```/.test(lines[p].trim())) {
            fence++
            if (fence === 2) { start = p; break }
          }
          p--
        }
      } else {
        // otherwise the block is a list (list markers + indented continuation
        // lines) or a paragraph: walk up while lines belong to the same block
        let p = start - 1
        while (p >= 0) {
          const raw = lines[p]
          const t = raw.trim()
          if (t === '' || /^#{1,6}\s/.test(t) || /^```/.test(t)) break
          if (/^[-*+]\s/.test(t) || /^\d+[.)]\s/.test(t) ||
              /^[>|]/.test(t) || /^\s+\S/.test(raw)) {
            p--
            continue
          }
          // ordinary paragraph line: a new block starts there, stop
          break
        }
        start = p + 1
      }
    }
    // extend downward: the block id can sit on the FIRST line and "own" the
    // lines below it. Only deeper-indented lines belong to this block
    // (nested list children); a sibling list item at the same indent starts
    // a new block.
    const idIndent = (lines[idx].match(/^\s*/) || [''])[0].length
    let end = idx
    while (end < lines.length - 1) {
      const raw = lines[end + 1]
      const t = raw.trim()
      if (t === '' || /^#{1,6}\s/.test(t) || /^```/.test(t)) break
      const indent = (raw.match(/^\s*/) || [''])[0].length
      if (indent > idIndent) {
        end++
        continue
      }
      break
    }
    const blockLines = lines.slice(start, end + 1)
    const idLineIndex = idx - start
    blockLines[idLineIndex] = blockLines[idLineIndex]
      .replace(new RegExp(`\\s*\\^${escapeRegExp(id)}\\s*$`), '')
      .trim()
    if (blockLines[idLineIndex] === '') blockLines.splice(idLineIndex, 1)
    const result = blockLines.join('\n').trim()
    return result === '' ? null : result
  }
  // heading reference: '## Some Heading' up to the next heading of same/higher level
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
  let result = str
  for (let i = matches.length - 1; i >= 0; i--) {
    const m = matches[i]
    const replacement = await replacer(m)
    result = result.slice(0, m.index) + replacement + result.slice(m.index + m[0].length)
  }
  return result
}


async function buildEmbed(filePath, subpath, sourcePath, embeds, visited) {
  if (visited.has(filePath)) return `<span class="mmng-embed-error">[循环引用: ${escapeHtml(filePath)}]</span>`
  visited.add(filePath)
  const file = await obsidianResolver.readMarkdown(filePath, sourcePath)
  visited.delete(filePath)
  if (!file) return null
  const block = extractBlock(file.content, subpath)
  if (block === null || block.trim() === '') return null
  const processed = await preprocessMarkdown(block, file.path, embeds, visited)
  const finalMd = /^\`\`\`ad-/m.test(processed) || !processed.includes('\n')
    ? processed
    : `\`\`\`ad-note\n${processed}\n\`\`\``
  const basename = file.path.split('/').pop()?.replace(/\.md$/, '') || filePath
  const label = escapeHtml(subpath || basename)
  embeds.push({ label: subpath || basename, md: finalMd })
  return `<mmng-embed data-index="${embeds.length - 1}" data-label="${label}"></mmng-embed>`
}

async function preprocessMarkdown(markdown, sourcePath, embeds = [], visited = new Set()) {
  return replaceAsync(markdown, /(!?)\[\[([^\]]+)\]\]/g, async (match) => {
    const bang = match[1] || ''
    const inner = match[2]
    const [link, ...params] = inner.split('|')
    const param = params.join('|')

    if (isImageLink(link)) {
      const dataUrl = await obsidianResolver.resolveImage(link, sourcePath)
      if (!dataUrl) return match[0]
      return `<img src="${dataUrl}" width="${imageWidthNumber(param)}">`
    }

    const [filePath, subpath] = splitSubpath(link)
    const isMarkdown = !/\.\w+$/.test(filePath) || /\.md$/i.test(filePath)

    if (isMarkdown && (bang || subpath)) {
      const embed = await buildEmbed(filePath, subpath, sourcePath, embeds, visited)
      if (embed !== null) return embed
      return `<span class="mmng-embed-error">[无法解析嵌入: ${escapeHtml(inner)}]</span>`
    }

    return `<a href="${escapeHtml(link)}">${escapeHtml(param || link)}</a>`
  })
}

// ---------- user's real structure: fenced code block + standalone ^id ----------
const adNote = `---\ncreated: 2026-08-19\n---\n\n前面内容\n\n\`\`\`ad-note\ntitle: 混合比例线段法\n本质均为溶液混合\n浓度=溶质/溶液  -> 所用溶液量之比\n\`\`\`\n\n^s6et6l\n\n后面内容\n`
const extracted = extractBlock(adNote, '^s6et6l')
console.log('=== ad-note block extract ===')
console.log(extracted)
assert.ok(extracted && extracted.includes('ad-note'), 'should extract the fenced block')
assert.ok(extracted.includes('混合比例线段法'), 'should include block content')
assert.ok(!extracted.includes('^s6et6l'), 'should strip the id marker')
assert.ok(!extracted.includes('前面内容'), 'should not include content before the fence')
console.log('ad-note fenced block extraction ✅')

// ---------- tests ----------
const input = [
  '- 块引用: ![[test#^abc123]]',
  '- 文件嵌入: ![[test]]',
  '- hover 引用: [[test#小节标题]]',
  '- 图片: [[img.png|300]]',
  '- 链接: [[test]]',
].join('\n')

const out = await preprocessMarkdown(input, 'current.md')
console.log('=== preprocess output ===')
console.log(out)
console.log('=========================')

assert.ok(out.includes('<mmng-embed'), 'should contain mmng-embed')
assert.ok(!out.includes('data-md='), 'markdown travels via the embeds array, not attributes')
assert.ok(out.includes('<img src="data:image/png;base64,MOCK" width="300">'), 'image should be inlined')
assert.ok(out.includes('<a href="test">test</a>'), 'plain link should stay a link')
console.log('All e2e preprocessing assertions passed ✅')

// ---------- user's real format through the full chain ----------
const realInput = [
  '- ![[10-学习笔记/10-09_考公/资料分析/思维导图Block#^s6et6l|思维导图Block]]',
  '- ![[10-学习笔记/10-09_考公/判断推理/思维导图Block#^bff7e9]]',
  '- [[形式逻辑知识点先导#^tz8z37|推出关系]]',
  '- [[资料分析#除法]]',
].join('\n')

const realOut = await preprocessMarkdown(realInput, '当前文件.md')
console.log('=== user-format preprocess output ===')
console.log(realOut)
console.log('======================================')

const embedTags = (realOut.match(/<mmng-embed/g) || []).length
assert.ok(embedTags >= 3, `expected >=3 mmng-embed tags, got ${embedTags}`)
assert.ok(realOut.includes('^s6et6l') === false || realOut.includes('data-label="^s6et6l"') || realOut.includes('data-label="思维导图Block"'), 's6et6l embed resolved')
console.log(`user-format preprocessing: ${embedTags} mmng-embed tags ✅`)

// verify markmap transform keeps the mmng-embed in the node tree
const { Transformer } = await import('markmap-lib')
const transformer = new Transformer()
const { root } = transformer.transform(realOut)
let foundInTree = 0
function walk(node) {
  if (node.content && node.content.includes('mmng-embed')) foundInTree++
  node.children?.forEach(walk)
}
walk(root)
console.log(`mmng-embed nodes surviving markmap transform: ${foundInTree}`)
assert.ok(foundInTree >= 3, `expected >=3 mmng-embed nodes in markmap tree, got ${foundInTree}`)
console.log('full chain (preprocess -> markmap transform) verified ✅')
