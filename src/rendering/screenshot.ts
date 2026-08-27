import { IMarkmapOptions, Markmap } from 'markmap-view'
import { TFile } from 'obsidian'

import { globalSettings, ScreenshotBgStyle } from 'src/settings/filesystem'


export interface ScreenshotColors {
  background: string;
  text: string;
}

export interface ExportHtmlData {
  markdown: string;
  sourcePath: string;
  filename: string;
  title: string;
  titleAsRootNode: boolean;
}

const SVG_NS = 'http://www.w3.org/2000/svg'

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


export async function downloadPng(
  markmap: Markmap,
  sourcePath: string,
  frontmatterColors: ScreenshotColors,
  filename: string,
  markmapOptions: Partial<IMarkmapOptions>
) {
  const themeColors = getThemeColors(markmap)
  const screenshotSettings = getScreenshotSettings(frontmatterColors, themeColors)
  await expandAll(markmap, markmapOptions)
  await markmap.fit()
  prepareSvgDom(screenshotSettings, markmap)

  try {
    const svg = markmap.svg.node()! as SVGSVGElement
    const pure = await convertToPureSvg(svg, sourcePath)
    const { width, height } = svg.getBoundingClientRect()
    setSvgExportSize(pure, width, height, screenshotSettings.background)
    const dataUrl = await createPngFromSvg(
      new XMLSerializer().serializeToString(pure),
      width, height, screenshotSettings.background, 2
    )
    downloadDataUrl(dataUrl, `${filename}.png`)
  } finally {
    restoreSvgDom(themeColors, markmap)
  }
}

export async function downloadSvg(
  markmap: Markmap,
  sourcePath: string,
  frontmatterColors: ScreenshotColors,
  filename: string,
  markmapOptions: Partial<IMarkmapOptions>
) {
  const themeColors = getThemeColors(markmap)
  const screenshotSettings = getScreenshotSettings(frontmatterColors, themeColors)
  await expandAll(markmap, markmapOptions)
  await markmap.fit()
  prepareSvgDom(screenshotSettings, markmap)

  try {
    const svg = markmap.svg.node()! as SVGSVGElement
    const pure = await convertToPureSvg(svg, sourcePath)
    const { width, height } = svg.getBoundingClientRect()
    setSvgExportSize(pure, width, height, screenshotSettings.background)
    const svgString = new XMLSerializer().serializeToString(pure)
    downloadBlob(new Blob([svgString], { type: 'image/svg+xml' }), `${filename}.svg`)
  } finally {
    restoreSvgDom(themeColors, markmap)
  }
}

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
    let start = idx
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
    // extend downward: the block id can sit on the FIRST line and "own" the
    // lines below it (e.g. a list item whose nested list follows). Include
    // consecutive list/indented/quote lines until a blank line, heading or
    // an unindented paragraph line.
    let end = idx
    while (end < lines.length - 1) {
      const raw = lines[end + 1]
      const t = raw.trim()
      if (t === '' || /^#{1,6}\s/.test(t) || /^```/.test(t)) break
      if (/^[-*+]\s/.test(t) || /^\d+[.)]\s/.test(t) ||
          /^[>|]/.test(t) || /^\s+\S/.test(raw)) {
        end++
        continue
      }
      // an unindented ordinary paragraph line starts a new block
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


const getThemeColors = (markmap: Markmap): ScreenshotColors => ({
  text: markmap.svg.style('color'),
  background: getComputedStyle(markmap.svg.node()!.parentElement!).backgroundColor
})

function getScreenshotSettings(
  frontmatterColors: ScreenshotColors,
  themeColors: ScreenshotColors
): ScreenshotColors {

  const globalSettingsBGC = {
    [ScreenshotBgStyle.Transparent]: 'transparent',
    [ScreenshotBgStyle.Color]: globalSettings.screenshotBgColor,
    [ScreenshotBgStyle.Theme]: themeColors.background
  }[ globalSettings.screenshotBgStyle ]

  const frontmatterBGC = frontmatterColors?.background

  const background = frontmatterBGC || globalSettingsBGC

  const text =
    frontmatterColors?.text ||
    globalSettings.screenshotTextColorEnabled && globalSettings.screenshotTextColor ||
    themeColors.text

  return { background, text }
}

// Static exports (PNG/SVG) capture the current view, so first expand every
// collapsed node to make sure the whole mindmap is included. markmap keeps
// user-folded nodes in payload.fold and setData(initialExpandLevel: -1) does
// not clear them, so we have to strip the folds explicitly.
async function expandAll(markmap: Markmap, options: Partial<IMarkmapOptions>) {
  const data = markmap.state.data
  clearFolds(data)
  await markmap.setData(data, { ...options, initialExpandLevel: -1, duration: 0 })
}

function clearFolds(node: any) {
  if (node.payload) delete node.payload.fold
  node.children?.forEach(clearFolds)
}

function prepareSvgDom({ text }: ScreenshotColors, markmap: Markmap) {
  setTextColor(text, markmap)
}

function setTextColor(textColor: string, markmap: Markmap) {
  const svg = markmap.svg

  svg.style('color', textColor)

  svg
    .node()!
    .querySelectorAll('div')
    .forEach(div => {
      div.style.color = textColor
    })
}

function restoreSvgDom(themeColors: ScreenshotColors, markmap: Markmap) {
  setTextColor(themeColors.text, markmap)
}

// ---------------------------------------------------------------------------
// Pure SVG conversion: turn markmap's DOM (which puts node text inside
// <foreignObject> HTML) into a pure SVG document with <text>/<image>
// elements, so the exported file renders identically everywhere (no
// dependency on Obsidian's stylesheets, and canvas/PNG rasterisation works).
// ---------------------------------------------------------------------------

interface TextFragment { text: string; bold?: boolean; italic?: boolean }
type Line = TextFragment[]
interface ExtractedImage { src: string; linktext?: string; width?: number; height?: number }

function extractLines(div: Element): { lines: Line[]; images: ExtractedImage[] } {
  const lines: Line[] = []
  const images: ExtractedImage[] = []
  let current: TextFragment[] = []
  const flush = () => {
    if (current.length) {
      lines.push(current)
      current = []
    }
  }

  const walk = (node: Node, bold: boolean, italic: boolean) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent
      if (text && text.trim() !== '') current.push({ text, bold, italic })
      return
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return
    const el = node as HTMLElement
    const tag = el.tagName
    if (tag === 'BR') { flush(); return }
    if (tag === 'STRONG' || tag === 'B') {
      Array.from(el.childNodes).forEach(c => walk(c, true, italic))
      return
    }
    if (tag === 'EM' || tag === 'I' || tag === 'CODE') {
      Array.from(el.childNodes).forEach(c => walk(c, bold, true))
      return
    }
    if (tag === 'SVG') return // icons inside callouts/embeds
    if (tag === 'IMG') {
      const img = el as HTMLImageElement
      // Obsidian embeds wrap the img in a span with the link text
      const embedSpan = el.closest('.internal-embed')
      images.push({
        src: img.getAttribute('src') || img.currentSrc || '',
        linktext: embedSpan?.getAttribute('src') || undefined,
        width: parseFloat(img.getAttribute('width') || '') || undefined,
        height: parseFloat(img.getAttribute('height') || '') || undefined,
      })
      flush()
      return
    }
    if (el.classList?.contains('katex-mathml')) {
      const annotation = el.querySelector('annotation')
      if (annotation?.textContent)
        current.push({ text: `[${annotation.textContent.trim()}]`, bold, italic })
      return
    }
    if (el.classList?.contains('katex-html')) return // use the annotation instead
    const blockTags = ['P','DIV','UL','OL','LI','H1','H2','H3','H4','H5','H6','HR','BLOCKQUOTE','TABLE','TR','PRE','SECTION','ARTICLE']
    const isBlock = blockTags.includes(tag)
    if (isBlock) flush()
    Array.from(el.childNodes).forEach(c => walk(c, bold, italic))
    if (isBlock) flush()
  }

  walk(div, false, false)
  flush()
  return { lines, images }
}

async function convertToPureSvg(sourceSvg: SVGSVGElement, sourcePath: string): Promise<SVGSVGElement> {
  const clone = sourceSvg.cloneNode(true) as SVGSVGElement

  // 1. paths: the CSS sets fill:none; without it the default black fill
  //    shows up as the "black S-shaped blocks" on the links.
  clone.querySelectorAll('path').forEach(path => {
    if (!path.getAttribute('fill'))
      path.setAttribute('fill', 'none')
  })

  // 2. circles: resolve var(--markmap-...) fills from the live DOM.
  const sourceCircles = sourceSvg.querySelectorAll('circle')
  clone.querySelectorAll('circle').forEach((circle, i) => {
    const fill = circle.getAttribute('fill')
    if (fill?.startsWith('var(')) {
      const resolved = sourceCircles[i] ? getComputedStyle(sourceCircles[i]).fill : ''
      circle.setAttribute('fill', resolved && !resolved.startsWith('var(') ? resolved : 'none')
    }
  })

  // 3. foreignObject -> <text> / <image>
  const sourceNodes = sourceSvg.querySelectorAll('g.markmap-node')
  const nodes = clone.querySelectorAll('g.markmap-node')
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i]
    const fo = node.querySelector('foreignObject')
    if (!fo) continue

    const sourceFo = sourceNodes[i]?.querySelector('foreignObject') || fo
    const div = sourceFo.querySelector('div')
    const style = div ? getComputedStyle(div) : null

    const foX = parseFloat(fo.getAttribute('x') || '') || 0
    const foY = parseFloat(fo.getAttribute('y') || '') || 0

    const fontSize = style ? parseFloat(style.fontSize) || 14 : 14
    const lineHeight = style && style.lineHeight !== 'normal'
      ? parseFloat(style.lineHeight) || fontSize * 1.2
      : fontSize * 1.2
    const color = style ? style.color : '#000000'
    const fontFamily = style ? style.fontFamily : undefined

    const { lines, images } = extractLines(div || sourceFo)
    if (!lines.length && !images.length) continue

    const group = document.createElementNS(SVG_NS, 'g')
    group.setAttribute('class', 'mmng-export-content')

    if (lines.length) {
      const text = document.createElementNS(SVG_NS, 'text')
      text.setAttribute('x', String(foX))
      text.setAttribute('dominant-baseline', 'central')
      if (fontFamily) text.setAttribute('font-family', fontFamily)
      text.setAttribute('font-size', String(fontSize))
      text.setAttribute('fill', color)

      lines.forEach((line, lineIndex) => {
        const tspan = document.createElementNS(SVG_NS, 'tspan')
        tspan.setAttribute('x', String(foX))
        tspan.setAttribute('y', String(foY + (lineIndex + 0.5) * lineHeight))
        for (const frag of line) {
          if (frag.bold || frag.italic) {
            const inner = document.createElementNS(SVG_NS, 'tspan')
            if (frag.bold) inner.setAttribute('font-weight', 'bold')
            if (frag.italic) inner.setAttribute('font-style', 'italic')
            inner.textContent = frag.text
            tspan.appendChild(inner)
          } else {
            tspan.appendChild(document.createTextNode(frag.text))
          }
        }
        text.appendChild(tspan)
      })
      group.appendChild(text)
    }

    // images: laid out below the text lines
    let imgY = foY + lines.length * lineHeight
    for (const img of images) {
      const dataUrl = await resolveImage(img, sourcePath)
      if (!dataUrl) continue
      const width = img.width || 200
      const height = img.height || 150
      const image = document.createElementNS(SVG_NS, 'image')
      image.setAttribute('x', String(foX))
      image.setAttribute('y', String(imgY))
      image.setAttribute('width', String(width))
      image.setAttribute('height', String(height))
      image.setAttribute('href', dataUrl)
      image.setAttribute('preserveAspectRatio', 'xMidYMid meet')
      group.appendChild(image)
      imgY += height
    }

    fo.replaceWith(group)
  }

  return clone
}

// Resolve an embedded image to a data URL (Obsidian local files must be
// inlined because the app:// protocol doesn't exist outside Obsidian).
async function resolveImage(img: ExtractedImage, sourcePath: string): Promise<string | null> {
  const linktext = img.linktext || img.src.replace(/^app:\/\/[^/]*\//, '')
  if (!linktext || linktext.startsWith('data:')) return img.src || null
  try {
    const file = app.metadataCache.getFirstLinkpathDest(linktext, sourcePath)
    if (!(file instanceof TFile)) return null
    const bytes = await app.vault.readBinary(file)
    const mime = {
      png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
      gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
    }[file.extension] || 'image/png'
    return `data:${mime};base64,${arrayBufferToBase64(bytes)}`
  } catch {
    return null
  }
}

function arrayBufferToBase64(buffer: ArrayBuffer) {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  const chunkSize = 0x8000
  for (let i = 0; i < bytes.length; i += chunkSize)
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize))
  return btoa(binary)
}

function createPngFromSvg(
  svgString: string,
  width: number,
  height: number,
  background: string,
  scale: number
) {
  const url = URL.createObjectURL(new Blob([svgString], { type: 'image/svg+xml' }))
  return loadImage(url).then(img => {
    try {
      const canvas = document.createElement('canvas')
      canvas.width = Math.max(1, Math.round(width * scale))
      canvas.height = Math.max(1, Math.round(height * scale))
      const ctx = canvas.getContext('2d')!
      if (background !== 'transparent') {
        ctx.fillStyle = background
        ctx.fillRect(0, 0, canvas.width, canvas.height)
      }
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
      return canvas.toDataURL('image/png')
    } finally {
      URL.revokeObjectURL(url)
    }
  })
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('Failed to load image'))
    img.src = src
  })
}

// Sets an explicit pixel size on the (cloned) svg so the exported file has a
// fixed dimension, and adds a background rect when the background is not
// transparent.
function setSvgExportSize(
  svg: SVGSVGElement,
  width: number,
  height: number,
  background: string
) {
  svg.style.setProperty('width', `${width}px`)
  svg.style.setProperty('height', `${height}px`)
  svg.setAttribute('width', String(width))
  svg.setAttribute('height', String(height))
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`)

  if (background === 'transparent') return

  const rect = document.createElementNS(SVG_NS, 'rect')
  rect.setAttribute('x', '0')
  rect.setAttribute('y', '0')
  rect.setAttribute('width', String(width))
  rect.setAttribute('height', String(height))
  rect.setAttribute('fill', background)
  svg.prepend(rect)
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

function downloadDataUrl(dataUrl: string, filename: string) {
  const a = document.createElement('a')
  a.href = dataUrl
  a.download = filename
  a.click()
}
