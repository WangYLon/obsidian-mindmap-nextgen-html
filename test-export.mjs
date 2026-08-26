// Headless-Chromium verification of the pure-SVG markmap export.
// Converts markmap's DOM (with foreignObject HTML) into a pure SVG document
// (text/image elements only), then verifies the result renders correctly.
// Usage: node test-export.mjs  (after `pnpm add -D puppeteer`)
import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import puppeteer from 'puppeteer'

const here = dirname(fileURLToPath(import.meta.url))
const d3 = readFileSync(resolve(here, 'node_modules/.pnpm/d3@7.9.0/node_modules/d3/dist/d3.min.js'), 'utf8')
const katex = readFileSync(resolve(here, 'node_modules/.pnpm/katex@0.16.47/node_modules/katex/dist/katex.min.js'), 'utf8')
const lib = readFileSync(resolve(here, 'node_modules/markmap-lib/dist/browser/index.iife.js'), 'utf8')
const view = readFileSync(resolve(here, 'node_modules/markmap-view/dist/browser/index.js'), 'utf8')

// 1x1 red PNG as data URL for image test
const tinyPng = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

const markdown = `# 根节点

## 一级节点 A

- 子节点 A1
- **粗体子节点** 和 *斜体内容*

## 一级节点 B

- 行内公式 $x^2 + y^2 = z^2$
- 块级公式 $$\\int_0^1 x^2 dx = \\frac{1}{3}$$
- 多级嵌套
  - 深层 1
    - 深层 2

## 一级节点 C

- ![测试图片](${tinyPng})
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
  const { root, features } = transformer.transform(markdown);
  const { styles, scripts } = transformer.getUsedAssets(features);
  if (scripts) markmap.loadJS(scripts);
  if (styles) markmap.loadCSS(styles);
  const mm = markmap.Markmap.create('#svg', { duration: 0 });
  mm.setData(root, { duration: 0 }).then(() => {
    // simulate a collapsed node
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

// ---- Pure SVG conversion logic (the core) ----
const convertLogic = `
function extractLines(div) {
  const lines = [];
  const images = [];
  let current = [];
  const flush = () => { if (current.length) { lines.push(current); current = []; } };

  function walk(node, bold, italic) {
    if (node.nodeType === 3) { // TEXT_NODE
      const text = node.textContent;
      if (text && text.trim() !== '') current.push({ text, bold, italic });
      return;
    }
    if (node.nodeType !== 1) return;
    const tag = node.tagName;
    if (tag === 'BR') { flush(); return; }
    if (tag === 'STRONG' || tag === 'B') { for (const c of node.childNodes) walk(c, true, italic); return; }
    if (tag === 'EM' || tag === 'I' || tag === 'CODE') { for (const c of node.childNodes) walk(c, bold, true); return; }
    if (tag === 'SVG') return; // icon svgs inside callouts
    if (tag === 'IMG') {
      images.push({
        src: node.getAttribute('src') || node.currentSrc || '',
        width: parseFloat(node.getAttribute('width')) || undefined,
        height: parseFloat(node.getAttribute('height')) || undefined,
        naturalWidth: node.naturalWidth || undefined,
        naturalHeight: node.naturalHeight || undefined,
      });
      flush();
      return;
    }
    if (node.classList && node.classList.contains('katex-mathml')) {
      const ann = node.querySelector('annotation');
      if (ann && ann.textContent) current.push({ text: '[' + ann.textContent.trim() + ']', bold, italic });
      return;
    }
    if (node.classList && node.classList.contains('katex-html')) return; // use annotation instead
    const blockTags = ['P','DIV','UL','OL','LI','H1','H2','H3','H4','H5','H6','HR','BLOCKQUOTE','TABLE','TR','PRE','SECTION','ARTICLE'];
    const isBlock = blockTags.includes(tag);
    if (isBlock) flush();
    for (const c of node.childNodes) walk(c, bold, italic);
    if (isBlock) flush();
  }
  walk(div, false, false);
  flush();
  return { lines, images };
}

function convertToPureSvg(sourceSvg) {
  const SVGNS = 'http://www.w3.org/2000/svg';
  const clone = sourceSvg.cloneNode(true);

  // 1. paths: ensure fill is none (CSS default is black fill!)
  clone.querySelectorAll('path').forEach(p => {
    if (!p.getAttribute('fill')) p.setAttribute('fill', 'none');
  });

  // 2. circles: resolve var(--...) fills from the live DOM
  const sourceCircles = sourceSvg.querySelectorAll('circle');
  clone.querySelectorAll('circle').forEach((c, i) => {
    const fill = c.getAttribute('fill');
    if (fill && fill.startsWith('var(')) {
      const src = sourceCircles[i];
      const resolved = src ? getComputedStyle(src).fill : null;
      c.setAttribute('fill', resolved && !resolved.startsWith('var(') ? resolved : 'none');
    }
  });

  // 3. foreignObject -> text / image
  const sourceNodes = sourceSvg.querySelectorAll('g.markmap-node');
  clone.querySelectorAll('g.markmap-node').forEach((node, i) => {
    const fo = node.querySelector('foreignObject');
    if (!fo) return;
    const sourceFo = sourceNodes[i] ? sourceNodes[i].querySelector('foreignObject') : fo;
    const div = sourceFo ? sourceFo.querySelector('div') : null;
    const style = div ? getComputedStyle(div) : null;

    const foX = parseFloat(fo.getAttribute('x')) || 0;
    const foY = parseFloat(fo.getAttribute('y')) || 0;
    const foW = parseFloat(fo.getAttribute('width')) || 100;
    const foH = parseFloat(fo.getAttribute('height')) || 20;

    const fontSize = style ? parseFloat(style.fontSize) || 14 : 14;
    const lineHeight = style && style.lineHeight !== 'normal'
      ? parseFloat(style.lineHeight) || fontSize * 1.2
      : fontSize * 1.2;
    const color = style ? style.color : '#000000';
    const fontFamily = style ? style.fontFamily : undefined;

    const { lines, images } = extractLines(div || sourceFo);

    const group = document.createElementNS(SVGNS, 'g');
    group.setAttribute('class', 'mmng-export-content');

    if (lines.length || images.length) {
      const text = document.createElementNS(SVGNS, 'text');
      text.setAttribute('x', String(foX));
      text.setAttribute('dominant-baseline', 'central');
      if (fontFamily) text.setAttribute('font-family', fontFamily);
      text.setAttribute('font-size', String(fontSize));
      text.setAttribute('fill', color);
      text.setAttribute('data-fo-height', String(foH));

      let lineIndex = 0;
      for (const line of lines) {
        const y = foY + (lineIndex + 0.5) * lineHeight;
        const tspan = document.createElementNS(SVGNS, 'tspan');
        tspan.setAttribute('x', String(foX));
        tspan.setAttribute('y', String(y));
        for (const frag of line) {
          if (frag.bold || frag.italic) {
            const inner = document.createElementNS(SVGNS, 'tspan');
            if (frag.bold) inner.setAttribute('font-weight', 'bold');
            if (frag.italic) inner.setAttribute('font-style', 'italic');
            inner.textContent = frag.text;
            tspan.appendChild(inner);
          } else {
            tspan.appendChild(document.createTextNode(frag.text));
          }
        }
        text.appendChild(tspan);
        lineIndex++;
      }
      group.appendChild(text);

      // images: placed below the text lines
      let imgY = foY + lines.length * lineHeight;
      for (const img of images) {
        if (!img.src) continue;
        const w = img.width || img.naturalWidth || 100;
        const h = img.height || img.naturalHeight || 100;
        const image = document.createElementNS(SVGNS, 'image');
        image.setAttribute('x', String(foX));
        image.setAttribute('y', String(imgY));
        image.setAttribute('width', String(w));
        image.setAttribute('height', String(h));
        image.setAttribute('href', img.src);
        image.setAttribute('preserveAspectRatio', 'xMidYMid meet');
        group.appendChild(image);
        imgY += h;
      }
    }

    fo.replaceWith(group);
  });

  return clone;
}
`

const exportSvgString = `
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
    const pure = convertToPureSvg(svg);
    const w = svg.getBoundingClientRect().width;
    const h = svg.getBoundingClientRect().height;
    pure.style.setProperty('width', w + 'px');
    pure.style.setProperty('height', h + 'px');
    pure.setAttribute('width', String(w));
    pure.setAttribute('height', String(h));
    pure.setAttribute('viewBox', '0 0 ' + w + ' ' + h);
    const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    rect.setAttribute('x', '0'); rect.setAttribute('y', '0');
    rect.setAttribute('width', String(w)); rect.setAttribute('height', String(h));
    rect.setAttribute('fill', '#ffffff');
    pure.prepend(rect);
    return new XMLSerializer().serializeToString(pure);
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

const svgString = await page.evaluate(`${convertLogic}; ${exportSvgString}; exportSvgString()`)
writeFileSync(resolve(here, '.verify/export-pure.svg'), svgString)
console.log('SVG written:', svgString.length, 'chars')

const check = {
  foreignObject: (svgString.match(/foreignObject/g) || []).length,
  textElements: (svgString.match(/<text /g) || []).length,
  tspans: (svgString.match(/<tspan/g) || []).length,
  fontWeights: (svgString.match(/font-weight/g) || []).length,
  fontStyles: (svgString.match(/font-style/g) || []).length,
  katexAnnotation: (svgString.match(/\[x\^2/g) || []).length,
  images: (svgString.match(/<image /g) || []).length,
  pathFillNone: (svgString.match(/fill="none"/g) || []).length,
  varFills: (svgString.match(/var\(/g) || []).length,
}
console.log('checks:', JSON.stringify(check, null, 2))

// Render the pure SVG standalone and analyze pixels
await page.goto('file://' + resolve(here, '.verify/export-pure.svg'), { waitUntil: 'networkidle0' })
await new Promise(r => setTimeout(r, 300))
const render = await page.evaluate(`(() => {
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
      let nonWhite = 0, nearBlack = 0, red = 0, total = w * h;
      for (let i = 0; i < px.length; i += 4) {
        const r = px[i], g = px[i+1], b = px[i+2];
        if (r < 245 || g < 245 || b < 245) nonWhite++;
        if (r < 60 && g < 60 && b < 60) nearBlack++;
        if (r > 200 && g < 80 && b < 80) red++;
      }
      resolve({ width: w, height: h, nonWhite, nearBlack, red, total });
    };
    img.onerror = () => resolve({ error: 'image load failed' });
    img.src = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(data)));
  });
})()`)
console.log('pure SVG render:', JSON.stringify(render))

// 4. PNG from the pure SVG (same mechanism as createPngFromSvg)
const pngDataUrl = await page.evaluate(`
  (async () => {
    const svg = document.querySelector('svg');
    const w = svg.clientWidth || 1280, h = svg.clientHeight || 800;
    const data = new XMLSerializer().serializeToString(svg);
    const img = new Image();
    await new Promise((resolve, reject) => { img.onload = resolve; img.onerror = reject; img.src = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(data))); });
    const c = document.createElementNS('http://www.w3.org/1999/xhtml', 'canvas');
    c.width = w * 2; c.height = h * 2;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL('image/png');
  })()
`)
const pngBuf = Buffer.from(pngDataUrl.split(',')[1], 'base64')
writeFileSync(resolve(here, '.verify/export-pure.png'), pngBuf)
console.log('PNG written:', pngBuf.length, 'bytes')

await browser.close()
console.log('done')
