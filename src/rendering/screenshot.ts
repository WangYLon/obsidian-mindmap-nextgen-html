import { IMarkmapOptions, Markmap } from 'markmap-view'
import { Component, MarkdownRenderer, TFile } from 'obsidian'

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
  const processed = await preprocessMarkdown(markdown, sourcePath)
  const html = renderHtml({ markdown: processed, title, titleAsRootNode })
  downloadBlob(new Blob([html], { type: 'text/html' }), `${filename}.html`)
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
  visited: Set<string> = new Set()
): Promise<string> {
  return replaceAsync(markdown, /(!?)\[\[([^\]]+)\]\]/g, async (match) => {
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

    // ![[file#sub]] embeds are rendered inline in the node
    if (bang && isMarkdown) {
      const embed = await buildEmbed(filePath, subpath, sourcePath, visited)
      return embed === null ? match[0] : embed.replace('data-mode="hover"', 'data-mode="inline"')
    }

    // [[file#sub]] wikilinks with a subpath show the block on hover
    if (subpath && isMarkdown) {
      const embed = await buildEmbed(filePath, subpath, sourcePath, visited)
      if (embed !== null) return embed
    }

    // Plain wikilinks become regular links
    return `<a href="${escapeHtml(link)}">${escapeHtml(param || link)}</a>`
  })
}

async function buildEmbed(
  filePath: string,
  subpath: string,
  sourcePath: string,
  visited: Set<string>
): Promise<string | null> {
  if (visited.has(filePath)) return `<em>[循环引用: ${escapeHtml(filePath)}]</em>`
  visited.add(filePath)
  const file = await obsidianResolver.readMarkdown(filePath, sourcePath)
  visited.delete(filePath)
  if (!file) return null
  const block = extractBlock(file.content, subpath)
  if (block === null) return null
  // Preprocess nested images/embeds inside the block, then render with
  // Obsidian's own renderer so formulas/callouts/tables come out identical
  // to how they look inside Obsidian.
  const processed = await preprocessMarkdown(block, file.path, visited)
  const html = await renderEmbedHtml(processed, file.path)
  const basename = file.path.split('/').pop()?.replace(/\.md$/, '') || filePath
  const label = escapeHtml(subpath || basename)
  return `<mmng-embed data-html="${escapeHtml(html)}" data-label="${label}" data-mode="hover"></mmng-embed>`
}

// Render markdown with Obsidian's renderer (the same API embeds.ts uses) so
// the exported HTML shows embedded content exactly as it looks in Obsidian.
async function renderEmbedHtml(markdown: string, sourcePath: string): Promise<string> {
  const container = createDiv()
  const component = new Component()
  try {
    await MarkdownRenderer.renderMarkdown(markdown, container, sourcePath, component)
    return container.innerHTML
  } finally {
    component.unload()
  }
}

const imageWidthNumber = (param: string) => {
  const match = param?.match(/^(\d+)/)
  return match ? match[1] : String(globalSettings.htmlImageWidth || 300)
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
    // Obsidian block ids sit at the end of a block's last line ("text ^id")
    const id = subpath.slice(1)
    const blocks = content.split(/\n\s*\n/)
    for (const block of blocks) {
      const lines = block.split('\n')
      let lastIndex = lines.length - 1
      while (lastIndex >= 0 && lines[lastIndex].trim() === '') lastIndex--
      if (lastIndex < 0) continue
      const last = lines[lastIndex]
      const inline = last.match(new RegExp(`^(.*?)\\s*\\^${escapeRegExp(id)}\\s*$`))
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

// Global regex replace with an async replacer (replaces from the end so that
// earlier match indices stay valid).
async function replaceAsync(
  str: string,
  regex: RegExp,
  replacer: (match: RegExpExecArray) => Promise<string> | string
): Promise<string> {
  const matches = [...str.matchAll(regex)]
  const replacements = await Promise.all(matches.map(m => replacer(m as unknown as RegExpExecArray)))
  let result = str
  for (let i = matches.length - 1; i >= 0; i--) {
    const m = matches[i]
    result = result.slice(0, m.index) + replacements[i] + result.slice(m.index + m[0].length)
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

function renderHtml({ markdown, title, titleAsRootNode }: Pick<ExportHtmlData, 'markdown' | 'title' | 'titleAsRootNode'>) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(title)}</title>
<style>
  html, body { margin: 0; padding: 0; width: 100%; height: 100%; }
  #mindmap { display: block; width: 100vw; height: 100vh; }
  .mmng-embed-ref, .mmng-img-ref { cursor: pointer; }
  .mmng-embed-trigger, .mmng-img-link { background: rgba(127, 127, 127, .15); border-radius: 4px; padding: 0 6px; font-size: .9em; white-space: nowrap; }
  .mmng-embed-inline { display: inline-block; text-align: left; }
  .mmng-embed-inline p { margin: 0 0 .4em; }
  .mmng-embed-inline > *:last-child { margin-bottom: 0; }
  .mmng-hover-panel { display: none; position: fixed; z-index: 9999; min-width: 200px; max-width: 520px; max-height: 60vh; overflow: auto; background: #fff; color: #333; border: 1px solid #ccc; border-radius: 6px; box-shadow: 0 4px 16px rgba(0, 0, 0, .2); padding: 8px 12px; font-size: 14px; line-height: 1.5; text-align: left; }
  .mmng-hover-panel img { max-width: 100%; height: auto; }
  .mmng-hover-panel pre { background: #f5f5f5; padding: 8px; border-radius: 4px; overflow: auto; }
  .mmng-hover-panel code { background: #f5f5f5; padding: 1px 4px; border-radius: 3px; }
  .mmng-hover-panel table { border-collapse: collapse; }
  .mmng-hover-panel th, .mmng-hover-panel td { border: 1px solid #ccc; padding: 4px 8px; }
</style>
</head>
<body>
<svg id="mindmap"></svg>
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
  const mm = markmap.Markmap.create('svg#mindmap');
  mm.setData(root);
  mm.fit();

  // ---- Obsidian-embed hover support ----
  // A single page-level floating panel (fixed position, outside the SVG so
  // it is never clipped by the mindmap's foreignObject boundaries).
  const hoverPanel = (() => {
    const el = document.createElement('div');
    el.className = 'mmng-hover-panel';
    document.body.appendChild(el);
    let hideTimer = null;
    return {
      show(content, x, y) {
        clearTimeout(hideTimer);
        el.innerHTML = content;
        el.style.display = 'block';
        const rect = el.getBoundingClientRect();
        el.style.left = Math.min(x, window.innerWidth - rect.width - 8) + 'px';
        el.style.top = Math.min(y, window.innerHeight - rect.height - 8) + 'px';
      },
      scheduleHide(delay) {
        hideTimer = setTimeout(() => { el.style.display = 'none'; el.innerHTML = ''; }, delay || 150);
      }
    };
  })();

  class MmngEmbed extends HTMLElement {
    connectedCallback() {
      const html = this.dataset.html || '';
      const label = this.dataset.label || 'embed';
      if (this.dataset.mode === 'inline') {
        this.classList.add('mmng-embed-inline');
        this.innerHTML = html;
        return;
      }
      this.classList.add('mmng-embed-ref');
      this.innerHTML = '<span class="mmng-embed-trigger">📄 ' + label + '</span>';
      this.addEventListener('mouseenter', (e) => {
        const r = this.getBoundingClientRect();
        hoverPanel.show(html, r.left, r.bottom + 4);
      });
      this.addEventListener('mouseleave', () => hoverPanel.scheduleHide());
    }
  }

  if (!customElements.get('mmng-embed')) customElements.define('mmng-embed', MmngEmbed);
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
