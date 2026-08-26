import { IMarkmapOptions, Markmap } from 'markmap-view'
import { toPng } from 'html-to-image'

import { globalSettings, ScreenshotBgStyle } from 'src/settings/filesystem'


export interface ScreenshotColors {
  background: string;
  text: string;
}

export interface ExportHtmlData {
  markdown: string;
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
  container: HTMLElement,
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
    const dataUrl = await toPng(container, {
      pixelRatio: 2,
      ...(screenshotSettings.background !== 'transparent'
        ? { backgroundColor: screenshotSettings.background }
        : {}),
    })
    downloadDataUrl(dataUrl, `${filename}.png`)
  } finally {
    restoreSvgDom(themeColors, markmap)
  }
}

export async function downloadSvg(
  markmap: Markmap,
  frontmatterColors: ScreenshotColors,
  filename: string,
  markmapOptions: Partial<IMarkmapOptions>
) {
  const themeColors = getThemeColors(markmap)
  const screenshotSettings = getScreenshotSettings(frontmatterColors, themeColors)
  await expandAll(markmap, markmapOptions)
  await markmap.fit()
  prepareSvgDom(screenshotSettings, markmap)

  const svg = markmap.svg.node()! as SVGSVGElement
  const clone = svg.cloneNode(true) as SVGSVGElement
  inlineStyles(svg, clone)

  const { width, height } = svg.getBoundingClientRect()
  setSvgExportSize(clone, width, height, screenshotSettings.background)
  const svgString = new XMLSerializer().serializeToString(clone)

  restoreSvgDom(themeColors, markmap)
  downloadBlob(new Blob([svgString], { type: 'image/svg+xml' }), `${filename}.svg`)
}

export function downloadHtml({ markdown, filename, title, titleAsRootNode }: ExportHtmlData) {
  const html = renderHtml({ markdown, title, titleAsRootNode })
  downloadBlob(new Blob([html], { type: 'text/html' }), `${filename}.html`)
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

// Recursively copy the computed style of each source element onto the
// corresponding target (clone) element, so the exported SVG keeps fonts,
// wrapping, link colours, katex layout etc. instead of relying on the
// Obsidian document's stylesheets.
function inlineStyles(source: Element, target: Element) {
  const computed = getComputedStyle(source)
  for (let i = 0; i < computed.length; i++) {
    const key = computed.item(i)
    if (!key) continue
    const value = computed.getPropertyValue(key)
    if (value)
      (target as HTMLElement).style.setProperty(key, value)
  }
  for (let i = 0; i < source.children.length; i++) {
    const sourceChild = source.children[i]
    const targetChild = target.children[i]
    if (targetChild)
      inlineStyles(sourceChild, targetChild)
  }
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
