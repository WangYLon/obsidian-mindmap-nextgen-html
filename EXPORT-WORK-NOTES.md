# Mindmap NextGen 导出功能开发记录(交接文档)

> 记录时间:导出功能开发暂停时
> 用途:日后继续导出功能(HTML/SVG/PNG)时的完整上下文:改了什么、为什么改、卡在哪、下一步怎么走。

---

## 1. 任务背景与目标

- **目标**:给导图 Tab 增加导出功能,支持 **HTML / SVG / PNG** 三种格式,方便分享导图。
- **现状**:功能骨架已完成(右键菜单有三个导出项,代码可构建、可运行),但**导出质量未达标,已暂停**:
  - PNG 在 Obsidian 中不可用(疑似 html-to-image 方案在真实环境不工作);
  - SVG 存在 4 个问题(见第 5 节);
  - HTML 逻辑已修复但未在真实 Obsidian 验证。
- **决定**:暂停导出工作,回归"分享笔记库"的简单方案。本文档保留所有上下文,方便日后继续。

---

## 2. 改动总览(相对原版 `git HEAD`)

| 文件 | 状态 | 内容概要 |
|---|---|---|
| `src/rendering/screenshot.ts` | 重写 | 核心:导出 PNG / SVG / HTML 三个函数(原 `takeScreenshot` 复制剪贴板被替换) |
| `src/rendering/renderer-tab.ts` | 修改 | 保存 markdown/file/设置到 state;暴露三个下载函数;PNG 时隐藏工具栏 |
| `src/views/view.ts` | 修改 | 右键菜单:"复制截图" → "导出为 PNG / SVG / HTML" 三项 |
| `src/translation/en.ts` | 修改 | `copyScreenshot` → `export.{png,svg,html}` |
| `src/translation/zh-simplified.ts` | 修改 | 同上(中文) |
| `src/translation/zh-traditional.ts` | 修改 | 同上(繁体) |
| `package.json` | 修改 | 新增依赖 `html-to-image`;删除废弃的 `pnpm` 字段 |
| `webpack.config.mts` | 删除 | 被 `.js` 替代 |
| `webpack.config.js` | 新增 | 原 `.mts` 去掉类型注解的等价物(任意 Node 版本可构建) |
| `pnpm-workspace.yaml` | 新增 | pnpm 11 配置迁移(见 3.7) |
| `test-export.mjs` | 新增 | headless Chromium 自动化验证脚本(需临时安装 puppeteer) |

---

## 3. 各文件详细说明

### 3.1 `src/rendering/screenshot.ts`(核心,264 行)

**原版**:`takeScreenshot(markmap, colors)` —— 用 `d3-svg-to-png` 生成 PNG **复制到剪贴板**。

**新版**:三个导出函数,公共逻辑复用原版的颜色处理(`getThemeColors` / `getScreenshotSettings` / `prepareSvgDom` / `setTextColor` / `restoreSvgDom`)。

#### `downloadPng(markmap, container, colors, filename, markmapOptions)`
- 流程:展开全部 → `fit()` → 设置截图文字颜色 → `html-to-image` 的 `toPng(container, { pixelRatio: 2, backgroundColor })` → 下载。
- **为什么弃用 `d3-svg-to-png`**:它走 "SVG → `<img>` → canvas" 路径,而 markmap 节点文字在 `<foreignObject>` 里的 HTML 中,**canvas 绘制图片时 foreignObject 的 HTML 内容不渲染**(文字会消失),所以 PNG 空白/不完整。
- **为什么用 `html-to-image` 对容器截图**:它直接对 DOM 截图,理论上能保留 HTML 渲染。
- ⚠️ **注意**:`html-to-image` 方案在**真实 Obsidian 环境中未被验证过**,用户反馈 PNG 仍不可用(见第 5 节)。

#### `downloadSvg(markmap, colors, filename, markmapOptions)`
- 流程:展开全部 → `fit()` → 设置文字颜色 → `cloneNode` 深拷贝 SVG → **递归内联计算样式**(`inlineStyles`)→ 设置导出尺寸/背景 → `XMLSerializer` 序列化 → 下载。
- **为什么内联样式**:SVG 文件脱离 Obsidian 后没有 Obsidian 的样式表,文字排版/连线颜色/公式布局会回退到默认值(截断、黑边、乱排)。内联后自带样式。
- 操作的是 clone,不影响 Obsidian 内视图;导出后恢复原 DOM 的文字颜色。

#### `downloadHtml({ markdown, filename, title, titleAsRootNode })`
- 生成一个**独立交互式 HTML**:内嵌 markdown 原文 + 引用 markmap 的 **CDN 浏览器构建**(d3@7、markmap-view、markmap-lib 的 `dist/browser/*`),打开后由 markmap 重新渲染,可折叠/缩放。
- 需要联网(CDN);内嵌 markdown 用 `JSON.stringify` + 转义 `<`(防 `</script>` 截断)。
- 版本硬编码 `0.18.12`,与 package.json 依赖一致(升级 markmap 时需同步改)。

#### 公共逻辑
- `expandAll` + `clearFolds`:静态导出前展开全部折叠节点。**关键**:markmap 把用户折叠状态存在 `payload.fold`,`setData(initialExpandLevel: -1)` **不会清除它**,必须递归 `delete node.payload.fold` 再 setData(见第 4 节经验 1)。
- `inlineStyles`:递归复制计算样式。⚠️ **已知 bug:strong/em 的 font-weight/font-style 没内联成功**(见第 5 节问题 2)。
- `setSvgExportSize`:给 clone 设置像素尺寸 + viewBox + 背景矩形(透明时无背景)。
- `toJsString` / `escapeHtml`:嵌入 HTML 模板时的转义。
- `downloadBlob` / `downloadDataUrl`:触发浏览器下载。

### 3.2 `src/rendering/renderer-tab.ts`

- `state` 新增 `markdown`(当前文件的完整原文,用于 HTML 导出)、`file`、`titleAsRootNode`。
  - ⚠️ **历史 bug(已修)**:最初存的是 `splitMarkdown('file', markdown).body`,而**无 frontmatter 的文件 `body` 是空字符串** → HTML 导出只有根节点。改为存**完整 markdown**(与 Obsidian 内渲染一致)。
- 返回对象新增三个导出函数;`downloadPng` 先隐藏工具栏(`toolbar.hidden = true`)再截图,`finally` 恢复。
- `contentEl` 断言为 `HTMLElement`(类型修正)。

### 3.3 `src/views/view.ts`

- `onPaneMenu`:原"复制截图"(`image-file` 图标)→ 三个导出项(`image` / `vector-square` / `file-code`),中间加分隔线。

### 3.4 翻译文件(en / zh-simplified / zh-traditional)

- `menu.copyScreenshot` → `menu.export.{ png, svg, html }`。

### 3.5 `package.json`

- 新增 `html-to-image: ^1.11.13`(PNG 截图)。
- 删除 `pnpm` 字段(`patchedDependencies` / `overrides`)——**pnpm 11 不再读取该字段**,迁移到 `pnpm-workspace.yaml`。

### 3.6 `webpack.config.mts` → `webpack.config.js`

- **原因**:webpack-cli 6 加载 `.mts` 配置依赖 Node 的类型剥离能力(仅 Node ≥ 23.6 默认开启)。在 Node 22 会报 `ERR_UNKNOWN_FILE_EXTENSION`。改成纯 JS 的 `.js` 后任意 Node 版本可构建。
- 内容与原 `.mts` 完全等价(仅去掉类型注解);CI(Node 23)也兼容。
- 构建命令不变:`pnpm run build` / `webpack --mode production`(webpack-cli 默认找 `webpack.config.js`)。

### 3.7 `pnpm-workspace.yaml`(新增)

```yaml
patchedDependencies:
  obsidian: patches/obsidian.patch
overrides:
  callbag: ^1.5.1
allowBuilds:
  esbuild: true
```

- **pnpm 11 配置迁移**:`patchedDependencies`(Obsidian 类型补丁)和 `overrides` 从 package.json 的 `pnpm` 字段搬到这里,否则补丁不生效(构建报类型错误)。
- **`allowBuilds: esbuild: true` 很关键**:pnpm 11 默认忽略依赖的构建脚本;不批准 esbuild 的话,pnpm 认为安装"未完成",每次 `pnpm run build` 都强制触发 `pnpm install` 并报 `ERR_PNPM_IGNORED_BUILDS`。

### 3.8 `test-export.mjs`(验证工具)

- 用 headless Chromium 自动渲染一个测试 markmap(含公式/折叠/多级节点),然后执行与插件相同的导出逻辑,检查 SVG 内容与 PNG 像素。
- **依赖 puppeteer**(已从项目依赖移除,想用时临时 `pnpm add -D puppeteer`)。
- 曾用到的 Chromium 下载(国内镜像不可用时用官方源):
  ```bash
  PUPPETEER_CACHE_DIR=.puppeteer node node_modules/puppeteer/install.mjs
  # 若镜像失败:直接用官方 googleapis 源(不设 PUPPETEER_DOWNLOAD_BASE_URL)
  ```
- 运行:`node test-export.mjs`(输出到 `.verify/` 目录)。

---

## 4. 调试中发现的关键技术坑(经验,省得重踩)

1. **markmap 折叠状态在 `payload.fold`,`setData(initialExpandLevel: -1)` 不会清除它** → 静态导出前必须 `clearFolds`(递归删 `payload.fold`)。
2. **canvas 绘制含 `<foreignObject>` 的 SVG 时,HTML 文字不渲染** → PNG 不能走 "SVG→`<img>`→canvas" 路线(d3-svg-to-png 就是这么挂的)。
3. `getComputedStyle` 迭代属性要用 `computed.item(i)`(for...of 在 TS 类型上会报错)。
4. **markmap-lib 的 katex 插件在 `transform()` 时同步调用 `katex.renderToString`**,而 katex 是异步 assets → **HTML 模板必须同步 `<script>` 加载 katex**,否则公式不转换(这是 HTML 模板加了 katex CDN script 的原因)。
5. **markmap 转换会丢弃纯段落文本**(只有标题/列表项成为节点)——写测试 markdown 时公式/文本要放列表项里。
6. katex 输出含 `.katex-mathml`(MathML 副本),用 `clip: rect(1px,1px,1px,1px)` 隐藏;SVG 内联样式后应保持隐藏(否则公式显示两份)。
7. pnpm 11:依赖构建脚本需在 `pnpm-workspace.yaml` 的 `allowBuilds` 批准;`patchedDependencies`/`overrides` 也在此文件。
8. webpack-cli 6 + `.mts` 配置在 Node < 23.6 不可用(见 3.6)。
9. Obsidian 的 `getFrontMatterInfo`:`contentStart` 在无 frontmatter 时为 0,`markdown.slice(0, contentStart)` 会是空串。

---

## 5. 未解决问题清单(继续任务的入口)

| # | 问题 | 现象 | 已定位的原因 | 下一步建议 |
|---|---|---|---|---|
| 1 | **PNG 不可用** | Obsidian 里导出的 PNG 不显示/空白 | html-to-image 方案未在真实 Obsidian 验证;疑似嵌套 foreignObject(HTML 容器内含 SVG,SVG 内又有 foreignObject)在图片上下文不渲染 | 见第 6 节"降级方案":PNG 从纯 SVG 生成 |
| 2 | **SVG 无粗体/斜体** | markdown 的 `**粗体**`/`*斜体*` 无样式 | `inlineStyles` 实测**没把 `font-weight`/`font-style` 写进内联 style**(测试环境已复现,strong/em 的 style 里缺这两个属性;原因待查,可能 getComputedStyle 迭代或 setProperty 问题) | 优先查 `inlineStyles`:对 strong/em 单独内联 font 相关属性,或用 CSS 规则内嵌代替逐元素内联 |
| 3 | **SVG 连接线 S 形黑块(边缘平滑)** | 曲线连线出现黑色块状,边缘平滑 | 未定位。疑似:① stroke 颜色没内联成 Obsidian 主题色(回退黑色);② fit() 的 transform scale 使 stroke-width 变粗 | 检查导出 SVG 里 `path` 的 stroke 颜色/宽度;可尝试序列化时把 fit transform 摊平或用固定 stroke-width |
| 4 | **SVG 一句话截断** | 长文本节点文字显示不全 | 未定位。疑似:内联了 div 的固定 height + overflow 后,导出环境字体不同导致换行更多被裁剪 | 检查节点 div 的 height/overflow 内联值;可考虑不内联 height 或按内容重算 |
| 5 | **SVG 个别公式显示两个** | 部分公式出现双份 | 未定位。疑似:部分 `.katex-mathml` 的 clip 隐藏没内联成功 | 检查 SVG 中所有 `.katex-mathml` 的 style 是否都有 clip/height:1px |
| 6 | **HTML 未验证** | — | 逻辑已修复(完整 markdown + katex 同步加载 + titleAsRootNode) | 在真实 Obsidian 里导出一份 HTML 双击打开验证 |

---

## 6. 推荐的后续方向(降级但可靠)

如果继续任务,建议换掉"序列化 Obsidian DOM"这条脆弱路线:

- **SVG**:把每个节点的 `<foreignObject>` HTML **转成纯 SVG `<text>`**(按行拆成 `<tspan>`;粗体/斜体映射 `font-weight`/`font-style`;公式显示 LaTeX 源码文本)。
- **PNG**:从纯 SVG 用 canvas 生成(没有 foreignObject,canvas 渲染可靠)。
- **HTML**:保持现在的交互式 CDN 模板不变。

**优点**:输出是纯 SVG 图形,不依赖 Obsidian 任何样式 → 能在 `test-export.mjs`(headless Chromium)里**完整验证**,不再盲改。
**代价**:公式显示源码而非渲染效果;排版比 HTML 简单。可接受的降级。

---

## 7. 如何恢复原样(回到原版)

```bash
# 恢复所有被修改/删除的已跟踪文件
git checkout -- package.json src/rendering/screenshot.ts src/rendering/renderer-tab.ts \
  src/views/view.ts src/translation/en.ts src/translation/zh-simplified.ts \
  src/translation/zh-traditional.ts webpack.config.mts

# 删除新增的未跟踪文件
rm -f webpack.config.js pnpm-workspace.yaml test-export.mjs
```

注意:恢复后 `pnpm-workspace.yaml` 消失,在 pnpm 11 下安装会回到"补丁不生效 + 构建脚本被忽略"的状态(见 3.7)。如果保留 `pnpm-workspace.yaml` 和 `webpack.config.js`,则只有导出功能代码被回滚,构建环境保持修复后的状态(推荐)。

---

## 8. 构建与验证备忘

```bash
pnpm install                 # pnpm 11,需要 pnpm-workspace.yaml 存在
pnpm run build               # 或 webpack --mode production;产物 main.js 在根目录
node test-export.mjs         # 导出验证(需临时 pnpm add -D puppeteer)
```

- 插件目录:`.obsidian/plugins/obsidian-mindmap-nextgen/`(main.js + manifest.json + styles.css)。
- 构建通过状态:最后一次 `webpack 5.109.2 compiled successfully`(TypeScript 类型检查亦通过,除项目原有的 DocumentFragment 类型错误——那是 obsidian.patch 未应用时的环境问题,正常安装后不存在)。
