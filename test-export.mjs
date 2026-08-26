// Headless-Chromium verification of the markmap PNG/SVG export logic.
// Usage: node test-export.mjs  (after `pnpm add puppeteer`)
import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import puppeteer from 'puppeteer'

const here = dirname(fileURLToPath(import.meta.url))
const d3 = readFileSync(resolve(here, 'node_modules/.pnpm/d3@7.9.0/node_modules/d3/dist/d3.min.js'), 'utf8')
const katex = readFileSync(resolve(here, 'node_modules/.pnpm/katex@0.16.47/node_modules/katex/dist/katex.min.js'), 'utf8')
const lib = readFileSync(resolve(here, 'node_modules/markmap-lib/dist/browser/index.iife.js'), 'utf8')
const view = readFileSync(resolve(here, 'node_modules/markmap-view/dist/browser/index.js'), 'utf8')

const markdown = `# 根节点

## 一级节点 A

- 子节点 A1
- 子节点 A2

## 一级节点 B

- 行内公式 $x^2 + y^2 = z^2$
- 块级公式 $$\\int_0^1 x^2 dx = \\frac{1}{3}$$
- 多级嵌套
  - 深层 1
    - 深层 2
      - 深层 3
        - 深层 4

## 一级节点 C

- **加粗文本** 和 *斜体* 以及 \`code\` 和 [链接](https://example.com)
- 普通列表项文字
`

const pageHtml = `<!DOCTYPE html>
<html>
<head>
<style>
  html, body { margin: 0; padding: 0; width: 100vw; height: 100vh; }
  #container { width: 100%; height: 100%; }
  #svg { width: 100%; height: 100%; }
</style>
</head>
<body>
<div id="container"><svg id="svg"></svg></div>
<script>${katex}</script>
<script>${d3}</script>
<script>${lib}</script>
<script>${view}</script>
<script>
  const markdown = ${JSON.stringify(markdown)};
  const { markmap } = window;
  const transformer = new markmap.Transformer();
  window.__transformer = transformer;
  const { root, features } = transformer.transform(markdown);
  const { styles, scripts } = transformer.getUsedAssets(features);
  if (scripts) markmap.loadJS(scripts);
  if (styles) markmap.loadCSS(styles);
  const mm = markmap.Markmap.create('#svg', { duration: 0 });
  mm.setData(root).then(() => {
    // simulate a collapsed node: fold the second child of the root
    const data = mm.state.data;
    const second = data.children[1];
    if (second) second.payload = { ...second.payload, fold: 1 };
    return mm.setData(data, { duration: 0 });
  }).then(() => mm.fit()).then(() => {
    window.__mm = mm;
    window.__ready = true;
  });
</script>
</body>
</html>`

// The same export logic as src/rendering/screenshot.ts
const exportLogic = `
  function inlineStyles(source, target) {
    const computed = getComputedStyle(source);
    for (let i = 0; i < computed.length; i++) {
      const key = computed.item(i);
      if (!key) continue;
      const value = computed.getPropertyValue(key);
      if (value) target.style.setProperty(key, value);
    }
    for (let i = 0; i < source.children.length; i++) {
      const s = source.children[i];
      const t = target.children[i];
      if (t) inlineStyles(s, t);
    }
  }
  async function exportSvgString() {
    const mm = window.__mm;
    function clearFolds(node) {
      if (node.payload) delete node.payload.fold;
      (node.children || []).forEach(clearFolds);
    }
    clearFolds(mm.state.data);
    await mm.setData(mm.state.data, { initialExpandLevel: -1, duration: 0 });
    await mm.fit();
    const svg = mm.svg.node();
    const clone = svg.cloneNode(true);
    inlineStyles(svg, clone);
    const w = svg.getBoundingClientRect().width;
    const h = svg.getBoundingClientRect().height;
    clone.style.setProperty('width', w + 'px');
    clone.style.setProperty('height', h + 'px');
    clone.setAttribute('width', String(w));
    clone.setAttribute('height', String(h));
    clone.setAttribute('viewBox', '0 0 ' + w + ' ' + h);
    const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    rect.setAttribute('x', '0'); rect.setAttribute('y', '0');
    rect.setAttribute('width', String(w)); rect.setAttribute('height', String(h));
    rect.setAttribute('fill', '#ffffff');
    clone.prepend(rect);
    return new XMLSerializer().serializeToString(clone);
  }
`

mkdirSync(resolve(here, '.verify'), { recursive: true })

const browser = await puppeteer.launch({
  headless: 'shell',
  executablePath: resolve(here, '.puppeteer/chrome-headless-shell/linux-152.0.7977.54/chrome-headless-shell-linux64/chrome-headless-shell'),
  args: ['--no-sandbox'],
})
const page = await browser.newPage()
await page.setViewport({ width: 1280, height: 800 })
await page.setContent(pageHtml)
await page.waitForFunction('window.__ready === true', { timeout: 15000 })
await new Promise(r => setTimeout(r, 500))

// 1. SVG export
const diag = await page.evaluate(`(() => {
  const mm = window.__mm;
  const strong = document.querySelector('strong');
  const em = document.querySelector('em');
  const dump = (el) => {
    if (!el) return null;
    const cs = getComputedStyle(el);
    const props = {};
    for (let i = 0; i < cs.length; i++) {
      const k = cs.item(i);
      if (/font|white-space|word|overflow|text-decoration|line-height/.test(k)) props[k] = cs.getPropertyValue(k);
    }
    return props;
  };
  return { strong: dump(strong), em: dump(em) };
})()`)
console.log('style diag:', JSON.stringify(diag, null, 2))
  const mm = window.__mm;
  const countNodes = (node) => 1 + (node.children || []).reduce((sum, c) => sum + countNodes(c), 0);
  const folded = [];
  const walk = (node, depth) => {
    if (node.payload && node.payload.fold) folded.push({ content: node.content, fold: node.payload.fold, depth });
    (node.children || []).forEach(c => walk(c, depth + 1));
  };
  walk(mm.state.data, 0);
  const formulaNodes = [];
  const walkAll = (node, depth) => {
    const c = node.content || '';
    if (c.includes('x^2') || c.includes('int') || c.includes('katex') || c.includes('$')) {
      formulaNodes.push({ content: c.slice(0, 120), depth });
    }
    (node.children || []).forEach(ch => walkAll(ch, depth + 1));
  };
  walkAll(mm.state.data, 0);
  const tree = [];
  const dump = (node, depth) => {
    tree.push('  '.repeat(depth) + (node.content || '').slice(0, 60));
    (node.children || []).forEach(c => dump(c, depth + 1));
  };
  dump(mm.state.data, 0);
  return {
    nodeCount: countNodes(mm.state.data),
    foldedNodes: folded,
    katexInDom: document.querySelectorAll('.katex').length,
    formulaNodes,
    tree,
    markdownItHtml: window.__transformer ? window.__transformer.md.render(markdown).slice(0, 600) : 'n/a',
    markdownLen: markdown.length,
  };
})()`)
console.log('page diag:', JSON.stringify(diag, null, 2))
const svgString = await page.evaluate(`${exportLogic}; exportSvgString()`)
writeFileSync(resolve(here, '.verify/export.svg'), svgString)
console.log('SVG written:', svgString.length, 'chars')

// diagnostics on the svg string
const diagnostics = {
  katexMathml: (svgString.match(/katex-mathml/g) || []).length,
  katexHtml: (svgString.match(/katex-html/g) || []).length,
  foreignObject: (svgString.match(/foreignObject/g) || []).length,
  inlineDivStyle: (svgString.match(/<div[^>]*style=/g) || []).length,
  displayNone: (svgString.match(/display:\s*none/g) || []).length,
  strokeInline: (svgString.match(/stroke:\s*[^;"]+/g) || []).length,
}
console.log('diagnostics:', JSON.stringify(diagnostics, null, 2))

// 2. PNG via html-to-image (inject from node_modules)
const htmlToImage = readFileSync(resolve(here, 'node_modules/html-to-image/dist/html-to-image.js'), 'utf8')
const pngDataUrl = await page.evaluate(`
  (async () => {
    ${htmlToImage};
    const container = document.getElementById('container');
    const toolbar = container.querySelector('.mm-toolbar');
    if (toolbar) toolbar.style.display = 'none';
    try {
      return await htmlToImage.toPng(container, { pixelRatio: 2, backgroundColor: '#ffffff' });
    } finally {
      if (toolbar) toolbar.style.display = '';
    }
  })()
`)
const pngBuf = Buffer.from(pngDataUrl.split(',')[1], 'base64')
writeFileSync(resolve(here, '.verify/export.png'), pngBuf)
console.log('PNG written:', pngBuf.length, 'bytes')

// crude blank check: sample some pixels via canvas
const blankness = await page.evaluate(`
  (async () => {
    ${htmlToImage};
    const container = document.getElementById('container');
    const dataUrl = await htmlToImage.toPng(container, { pixelRatio: 1, backgroundColor: '#ffffff' });
    const img = new Image();
    await new Promise(r => { img.onload = r; img.src = dataUrl; });
    const c = document.createElement('canvas');
    c.width = img.width; c.height = img.height;
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const { data } = ctx.getImageData(0, 0, img.width, img.height);
    let nonWhite = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] < 245 || data[i+1] < 245 || data[i+2] < 245) nonWhite++;
    }
    return { width: img.width, height: img.height, nonWhitePixels: nonWhite, totalPixels: img.width * img.height };
  })()
`)
console.log('PNG blankness:', JSON.stringify(blankness))

// 3. Render the exported SVG as a standalone document (like opening the file
// in a browser) and analyze pixels for black edges / missing text.
await page.goto('file://' + resolve(here, '.verify/export.svg'), { waitUntil: 'networkidle0' })
await new Promise(r => setTimeout(r, 300))
const svgRender = await page.evaluate(`(() => {
  const svg = document.querySelector('svg');
  const c = document.createElementNS('http://www.w3.org/1999/xhtml', 'canvas');
  const w = svg.clientWidth || 1280, h = svg.clientHeight || 800;
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, w, h);
  const data = new XMLSerializer().serializeToString(svg);
  return new Promise(resolve => {
    const img = new Image();
    img.onload = () => {
      ctx.drawImage(img, 0, 0, w, h);
      const { data: px } = ctx.getImageData(0, 0, w, h);
      let nonWhite = 0, nearBlack = 0, total = w * h;
      for (let i = 0; i < px.length; i += 4) {
        const r = px[i], g = px[i+1], b = px[i+2];
        if (r < 245 || g < 245 || b < 245) nonWhite++;
        if (r < 60 && g < 60 && b < 60) nearBlack++;
      }
      resolve({ width: w, height: h, nonWhite, nearBlack, total });
    };
    img.onerror = () => resolve({ error: 'image load failed' });
    img.src = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(data)));
  });
})()`)
console.log('SVG standalone render:', JSON.stringify(svgRender))

await browser.close()
console.log('done')
