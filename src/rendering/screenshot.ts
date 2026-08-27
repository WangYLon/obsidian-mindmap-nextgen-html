import { TFile } from 'obsidian'

import { globalSettings } from 'src/settings/filesystem'


export interface ExportHtmlData {
  markdown: string;
  sourcePath: string;
  filename: string;
  title: string;
  titleAsRootNode: boolean;
}


// Keep in sync with the markmap-* versions in package.json.
// The browser builds of markmap-* are IIFE/UMD bundles that attach to
// window.markmap; markmap-view additionally requires a global d3.
const D3_CDN = 'https://cdn.jsdelivr.net/npm/d3@7'
const MARKMAP_VIEW_CDN = 'https://cdn.jsdelivr.net/npm/markmap-view@0.18.12/dist/browser/index.js'
const MARKMAP_LIB_CDN = 'https://cdn.jsdelivr.net/npm/markmap-lib@0.18.12/dist/browser/index.iife.js'
// katex must be loaded synchronously before transform() so that inline math
// is rendered (markmap-lib's katex plugin calls katex.renderToString during
// transform, which happens before its async assets are loaded).
const KATEX_VERSION = '0.16.18'
const KATEX_CDN = `https://cdn.jsdelivr.net/npm/katex@${KATEX_VERSION}`


export async function downloadHtml({ markdown, sourcePath, filename, title, titleAsRootNode }: ExportHtmlData) {
  const embeds: ExportEmbed[] = []
  const processed = await preprocessMarkdown(markdown, sourcePath, embeds)
  const calloutCss = extractCalloutCss()
  const textFont = extractTextFont()
  const html = renderHtml({ markdown: processed, embeds, calloutCss, textFont, title, titleAsRootNode })
  downloadBlob(new Blob([html], { type: 'text/html' }), `${filename}.html`)
}

export interface ExportEmbed {
  label: string
  md: string
}

// Read the user's Obsidian body font (--font-text-override, --font-text or
// the computed body font) so the exported HTML uses the same typography.
function extractTextFont(): string {
  try {
    const body = getComputedStyle(document.body)
    return body.getPropertyValue('--font-text-override').trim()
      || body.getPropertyValue('--font-text').trim()
      || body.fontFamily
  } catch {
    return ''
  }
}

// Capture the real Obsidian callout styles (the Admonition/callout look) by
// probing a rendered .callout element, so embedded ad-note blocks in the
// exported HTML match what the user sees in Obsidian.
function extractCalloutCss(): string {
  try {
    const probe = createDiv()
    probe.addClass('callout')
    probe.setAttribute('data-callout', 'note')
    probe.innerHTML =
      '<div class="callout-title">标题</div><div class="callout-content">内容</div>'
    probe.style.cssText = 'position:fixed;left:-9999px;top:0;z-index:-1'
    document.body.appendChild(probe)
    try {
      const main = getComputedStyle(probe)
      const title = getComputedStyle(probe.querySelector('.callout-title') as HTMLElement)
      const content = getComputedStyle(probe.querySelector('.callout-content') as HTMLElement)
      const borderColor = main.borderLeftColor === 'rgb(0, 0, 0)' && main.borderLeftWidth === '0px'
        ? 'var(--callout-color, #448aff)'
        : main.borderLeftColor
      return `
.mmng-callout {
  background: ${main.backgroundColor};
  border-left: ${main.borderLeftWidth} ${main.borderLeftStyle} ${borderColor};
  border-radius: ${main.borderRadius};
  padding: ${main.paddingTop} ${main.paddingRight} ${main.paddingBottom} ${main.paddingLeft};
  color: ${main.color};
  font-size: ${main.fontSize};
  line-height: ${main.lineHeight};
}
.mmng-callout-title {
  color: ${title.color};
  font-weight: ${title.fontWeight};
  padding: ${title.paddingTop} ${title.paddingRight} ${title.paddingBottom} ${title.paddingLeft};
  background: ${title.backgroundColor};
}
.mmng-callout-content {
  padding: ${content.paddingTop} ${content.paddingRight} ${content.paddingBottom} ${content.paddingLeft};
}
`
    } finally {
      probe.remove()
    }
  } catch {
    return ''
  }
}

// ---------------------------------------------------------------------------
// Markdown preprocessing for the exported HTML.
// The exported file is standalone (no Obsidian runtime), so Obsidian-specific
// syntax must be translated into plain markdown/HTML first:
//   ![[img.png]]        -> <img src="data:...">           (base64 inlined)
//   ![[img.png|300]]    -> <img src="data:..." width="300">
//   [[img.png|300]]     -> <img ...>                      (previewed too)
//   ![[file#^block]]    -> <span class="mmng-embed-ref">…hover panel…</span>
//   [[other note]]      -> <a href="...">
// ---------------------------------------------------------------------------

const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp']

const obsidianResolver = {
  async resolveImage(linktext: string, sourcePath: string): Promise<string | null> {
    try {
      const file = app.metadataCache.getFirstLinkpathDest(linktext, sourcePath)
      if (!(file instanceof TFile) || !IMAGE_EXTENSIONS.includes(file.extension.toLowerCase())) return null
      const mime = {
        png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
        gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp',
      }[file.extension.toLowerCase()] || 'image/png'
      const bytes = await app.vault.readBinary(file)
      return `data:${mime};base64,${arrayBufferToBase64(bytes)}`
    } catch { return null }
  },

  async readMarkdown(linktext: string, sourcePath: string): Promise<{ content: string; path: string } | null> {
    try {
      const file = app.metadataCache.getFirstLinkpathDest(linktext, sourcePath)
      if (!(file instanceof TFile) || file.extension !== 'md') return null
      return { content: await app.vault.cachedRead(file), path: file.path }
    } catch { return null }
  }
}

async function preprocessMarkdown(
  markdown: string,
  sourcePath: string,
  embeds: ExportEmbed[] = [],
  visited: Set<string> = new Set()
): Promise<string> {
  return replaceAsync(bulletifyBareEmbeds(markdown), /(!?)\[\[([^\]]+)\]\]/g, async (match) => {
    const bang = match[1] || ''
    const inner = match[2]
    const [link, ...params] = inner.split('|')
    const param = params.join('|')

    // Images (both ![[img|w]] and [[img|w]]) become inlined <img> with the
    // width from the |param or the global htmlImageWidth setting
    if (isImageLink(link)) {
      const dataUrl = await obsidianResolver.resolveImage(link, sourcePath)
      if (!dataUrl) return match[0]
      return `<img src="${dataUrl}" width="${imageWidthNumber(param)}">`
    }

    const [filePath, subpath] = splitSubpath(link)
    const isMarkdown = !/\.\w+$/.test(filePath) || /\.md$/i.test(filePath)

    // Embeds: ![[...]] always; [[...#...]] references to a block/heading are
    // also rendered inline (no hover).
    if (isMarkdown && (bang || subpath)) {
      const embed = await buildEmbed(filePath, subpath, sourcePath, embeds, visited)
      if (embed !== null) return embed
      console.warn('[mmng-export] failed to resolve embed:', inner, 'from', sourcePath)
      return `<span class="mmng-embed-error">[无法解析嵌入: ${escapeHtml(inner)}]</span>`
    }

    // Plain wikilinks become regular links
    return `<a href="${escapeHtml(link)}">${escapeHtml(param || link)}</a>`
  })
}

async function buildEmbed(
  filePath: string,
  subpath: string,
  sourcePath: string,
  embeds: ExportEmbed[],
  visited: Set<string>
): Promise<string | null> {
  if (visited.has(filePath)) return `<span class="mmng-embed-error">[循环引用: ${escapeHtml(filePath)}]</span>`
  visited.add(filePath)
  const file = await obsidianResolver.readMarkdown(filePath, sourcePath)
  visited.delete(filePath)
  if (!file) {
    console.warn('[mmng-export] file not found:', filePath, 'from', sourcePath)
    return null
  }
  const block = extractBlock(file.content, subpath)
  if (block === null || block.trim() === '') {
    console.warn('[mmng-export] block extract failed:', JSON.stringify(subpath),
      'in', filePath, '| content head:', JSON.stringify(file.content.slice(0, 400)))
    return null
  }
  // Preprocess nested images/embeds inside the block, then render with
  // Obsidian's own renderer so formulas/callouts/tables come out identical
  // to how they look inside Obsidian.
  const processed = await preprocessMarkdown(block, file.path, embeds, visited)
  // Wrap multi-line non-callout blocks (e.g. nested lists) in an ad-note fence
  // so they render as a single callout block, which markmap measures reliably.
  const finalMd = /^```ad-/m.test(processed) || !processed.includes('\n')
    ? processed
    : `\`\`\`ad-note\n${processed}\n\`\`\``
  const basename = file.path.split('/').pop()?.replace(/\.md$/, '') || filePath
  const label = escapeHtml(subpath || basename)
  embeds.push({ label: subpath || basename, md: finalMd })
  console.log('[mmng-export] resolved embed:', subpath || basename, 'from', filePath, 'mdLen=' + finalMd.length)
  return `<mmng-embed data-index="${embeds.length - 1}" data-label="${label}"></mmng-embed>`
}

const imageWidthNumber = (param: string) => {
  const match = param?.match(/^(\d+)/)
  return match ? match[1] : String(globalSettings.htmlImageWidth || 300)
}

// markmap drops bare paragraph lines (only headings/lists become nodes), so a
// line that is entirely an embed reference (e.g. "![[file#^block]]" or
// "[[file#标题]]" on its own line) would vanish from the exported mindmap.
// Turn such bare lines into list items so they survive the transform.
function bulletifyBareEmbeds(markdown: string): string {
  return markdown.split('\n').map(line => {
    if (line.trim() === '' || line.startsWith('-') || line.startsWith('#')) return line
    const trimmed = line.trim()
    const isEmbed = /^!\[\[[^\]]+\]\]$/.test(trimmed) || /^\[\[[^\]]*#[^\]]*\]\]$/.test(trimmed)
    return isEmbed ? `- ${line}` : line
  }).join('\n')
}

const isImageLink = (link: string) => {
  const ext = link.split('.').pop()?.toLowerCase()
  return !!ext && IMAGE_EXTENSIONS.includes(ext)
}

// 'file#^block' / 'file#heading' -> ['file', '^block' | 'heading' | '']
const splitSubpath = (link: string): [string, string] => {
  const hashIndex = link.indexOf('#')
  if (hashIndex === -1) return [link, '']
  return [link.slice(0, hashIndex), link.slice(hashIndex + 1)]
}

// Extract the markdown content of a block reference from a file's raw text.
function extractBlock(content: string, subpath: string): string | null {
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

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// Global regex replace with an async replacer. Runs serially from the end
// towards the start so that (a) earlier match indices stay valid and (b) the
// visited set in preprocessMarkdown never sees a "concurrently in progress"
// file and mistakes it for a circular reference.
async function replaceAsync(
  str: string,
  regex: RegExp,
  replacer: (match: RegExpExecArray) => Promise<string> | string
): Promise<string> {
  const matches = [...str.matchAll(regex)]
  let result = str
  for (let i = matches.length - 1; i >= 0; i--) {
    const m = matches[i]
    const replacement = await replacer(m as unknown as RegExpExecArray)
    result = result.slice(0, m.index) + replacement + result.slice(m.index + m[0].length)
  }
  return result
}


function arrayBufferToBase64(buffer: ArrayBuffer) {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  const chunkSize = 0x8000
  for (let i = 0; i < bytes.length; i += chunkSize)
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize))
  return btoa(binary)
}

function renderHtml({ markdown, embeds, calloutCss, textFont, title, titleAsRootNode }: Pick<ExportHtmlData, 'markdown' | 'title' | 'titleAsRootNode'> & { embeds: ExportEmbed[]; calloutCss: string; textFont: string }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(title)}</title>
<style>
  html, body { margin: 0; padding: 0; width: 100%; height: 100%; }
  #mindmap { display: block; width: 100vw; height: 100vh; }
  ${textFont ? `body, .markmap-foreign, .mmng-embed-inline { font-family: ${textFont}; }` : ''}
  .mmng-embed-inline { display: inline-block; text-align: left; }
  .mmng-embed-inline p { margin: 0 0 .4em; }
  .mmng-embed-inline > *:last-child { margin-bottom: 0; }
  .mmng-embed-inline img { max-width: 100%; height: auto; }
  .mmng-embed-inline pre { background: #f5f5f5; padding: 8px; border-radius: 4px; overflow: auto; }
  .mmng-embed-inline code { background: #f5f5f5; padding: 1px 4px; border-radius: 3px; }
  .mmng-embed-inline table { border-collapse: collapse; }
  .mmng-embed-inline th, .mmng-embed-inline td { border: 1px solid #ccc; padding: 4px 8px; }
  .mmng-callout { border-left: 3px solid #448aff; border-radius: 4px; padding: 6px 10px; margin: 4px 0; background: rgba(127, 127, 127, .08); }
  .mmng-callout-title { font-weight: 600; margin-bottom: 4px; }
  .mmng-callout-content > :first-child { margin-top: 0; }
  .mmng-callout-content > :last-child { margin-bottom: 0; }
  ${calloutCss}
  .mmng-embed-error { color: #b00; font-style: italic; }
</style>
</head>
<body>
<svg id="mindmap"></svg>
<script>
  // embeds travel as base64 so no escaping can corrupt the generated JS
  const mmngEmbeds = JSON.parse(decodeURIComponent(escape(atob("${btoa(unescape(encodeURIComponent(JSON.stringify(embeds))))}"))));
</script>
<link rel="stylesheet" href="${KATEX_CDN}/dist/katex.min.css">
<script src="${KATEX_CDN}/dist/katex.min.js"></script>
<script src="${D3_CDN}"></script>
<script src="${MARKMAP_VIEW_CDN}"></script>
<script src="${MARKMAP_LIB_CDN}"></script>
<script>
  const markdown = ${toJsString(markdown)};
  const rootTitle = ${toJsString(title)};
  const titleAsRootNode = ${titleAsRootNode};
  const { markmap } = window;
  const transformer = new markmap.Transformer();
  let { root, features } = transformer.transform(markdown);
  const { styles, scripts } = transformer.getUsedAssets(features);
  if (scripts) markmap.loadJS(scripts);
  if (styles) markmap.loadCSS(styles);
  if (titleAsRootNode) {
    if (root.content == '') root.content = rootTitle;
    else root = { content: rootTitle, children: [root] };
  }

  // ---- Obsidian-embed support ----
  // <mmng-embed data-index="N"> looks up its markdown in mmngEmbeds and
  // renders it with the page's own markdown-it (formulas work thanks to the
  // katex assets loaded above). The custom element MUST be registered before
  // setData(): markmap lays out nodes while injecting their HTML, so the
  // connectedCallback fills the content synchronously and markmap measures
  // the real size of the embed (otherwise the foreignObject is sized as if
  // the embed were empty and the content gets clipped).
  const fence = String.fromCharCode(96);
  function renderEmbedMd(md) {
    // Convert fenced "ad-<type>" blocks (Obsidian Admonition syntax) into
    // callout-style HTML, then render the rest with markdown-it.
    // NOTE: no backslash escapes here - esbuild re-escapes them when the
    // template is compiled, which corrupts the generated JS.
    const fence3 = fence + fence + fence;
    const LF = String.fromCharCode(10);
    const re = new RegExp(fence3 + 'ad-([a-z]+)' + LF + '([^]*?)' + fence3, 'g');
    md = md.replace(re, function (m, type, content) {
      const lines = content.split(LF);
      let title = type;
      if (lines[0] && lines[0].indexOf('title:') === 0) {
        title = lines.shift().slice(6).trim();
      }
      const inner = transformer.md.render(lines.join(LF));
      return '<div class="mmng-callout mmng-callout-' + type + '"><div class="mmng-callout-title">' + title + '</div><div class="mmng-callout-content">' + inner + '</div></div>';
    });
    return transformer.md.render(md);
  }
  class MmngEmbed extends HTMLElement {
    connectedCallback() {
      this.classList.add('mmng-embed-inline');
      const idx = parseInt(this.dataset.index || '-1', 10);
      const entry = (typeof mmngEmbeds !== 'undefined' && mmngEmbeds[idx]) || null;
      this.innerHTML = entry ? renderEmbedMd(entry.md) : '';
    }
  }
  if (!customElements.get('mmng-embed')) customElements.define('mmng-embed', MmngEmbed);

  const mm = markmap.Markmap.create('svg#mindmap');
  mm.setData(root).then(() => {
    // Re-render once so markmap re-measures the embeds: the first layout
    // happens right after node HTML is injected, and re-running renderData
    // re-measures foreignObject scroll sizes with the embed content present.
    return mm.renderData ? mm.renderData() : null;
  }).then(() => {
    mm.fit();
    console.log('[mmng-export] mmng-embed elements:', document.querySelectorAll('mmng-embed').length);
    document.querySelectorAll('mmng-embed').forEach((el, i) => {
      const rect = el.getBoundingClientRect();
      const fo = el.closest('foreignObject');
      const contentDiv = fo ? fo.firstChild.firstChild : null;
      console.log('[mmng-export] #' + i + ' label="' + (el.dataset.label || '') + '" renderedLen=' + el.innerHTML.length
        + ' embed=' + Math.round(rect.width) + 'x' + Math.round(rect.height)
        + ' foH=' + (fo ? fo.getAttribute('height') : '?')
        + ' scrollH=' + (contentDiv ? contentDiv.scrollHeight : '?')
        + ' foOverflow=' + (fo ? getComputedStyle(fo).overflow : '?'));
    });
  });
</script>
</body>
</html>`
}

const toJsString = (s: string) =>
  JSON.stringify(s).replace(/</g, '\\u003c')

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}
