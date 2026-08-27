# Mindmap NextGen 导出功能开发记录(最终版)

> 状态:**HTML 导出功能已完成并验证满意**。PNG/SVG 导出经多轮尝试后决定**移除**,仅保留 HTML(交互式、公式正常、支持 Obsidian 嵌入)。
> 本文档是开发全程的技术沉淀,供后续维护/发布参考。

---

## 1. 最终结果

- ✅ **导出为 HTML**:右键菜单 → "Export as HTML",生成独立交互式 HTML(需联网,CDN 渲染),与 Obsidian 内渲染一致:
  - markdown 导图(可折叠/缩放)
  - **公式**(katex CDN 同步加载)
  - **嵌入块**(`![[file#^block]]` / `[[file#标题]]` 直接显示;ad-note 转 Obsidian callout 样式)
  - **图片**(`![[img.png|300]]` / `[[img.png]]` 转 base64 内嵌,支持宽度参数)
  - **字体**(跟随 Obsidian 正文字体 `--font-text-override`)
- ❌ **PNG / SVG**:经多轮尝试(纯 SVG 降级方案、基于 HTML 渲染的 iframe 方案)均不满足要求,已按决定**从代码中移除**,菜单仅保留 HTML。

## 2. 最终代码架构(HTML 导出)

```
右键菜单 → renderer-tab.downloadHtml()
  → 动态 import('src/rendering/screenshot')(懒加载,插件启动更轻)
  → downloadHtml({ markdown, sourcePath, filename, title, titleAsRootNode })
    → preprocessMarkdown(markdown, sourcePath, embeds)
        · bulletifyBareEmbeds:裸行嵌入 → 列表项(markmap 丢弃裸段落)
        · 图片 [[...]] / ![[...]] → <img src="data:base64" width="参数|全局设置">
        · 嵌入块 → <mmng-embed data-index="N"> + embeds 数组(JSON/base64 传递)
        · [[普通链接]] → <a>
        · buildEmbed:读目标文件 → extractBlock(块/标题提取)→ 递归预处理
    → extractCalloutCss():探针 .callout 元素提取 Obsidian callout 真实样式
    → extractTextFont():读取 --font-text-override 正文字体
    → renderHtml():生成独立 HTML 模板(CDN: d3@7 + markmap-view/lib 0.18.12 + katex 0.16.18)
        · 内嵌 mmngEmbeds 数组(base64 编码,避免转义破坏 JS)
        · <mmng-embed> 自定义元素:connectedCallback 用页面内 markdown-it 渲染
        · ad-note 围栏 → callout div(renderEmbedMd)
        · 渲染完成设 document.body.dataset.mmngReady(供 iframe 导出用,已弃用)
  → downloadBlob 下载 .html
```

## 3. 已解决的技术难点(含多轮迭代,省得重踩)

### 3.1 markdown 预处理
1. **无 frontmatter 文件 body 为空**:`getFrontMatterInfo` 的 `contentStart` 无 frontmatter 时为 0 → 导出必须用**完整 markdown 原文**,不是 `splitMarkdown().body`。
2. **katex 同步加载**:markmap-lib 的 katex 插件在 `transform()` 时同步调 `katex.renderToString` → HTML 模板必须**同步 `<script>` 加载 katex**,否则公式不转换。
3. **markmap 丢弃裸段落**:裸行(非标题/列表)不会成为节点 → 裸行嵌入需转列表项(`bulletifyBareEmbeds`)。
4. **并发循环引用误判**:`replaceAsync` 用 `Promise.all` 并发处理所有匹配,`visited` 集合会误判"正在处理中的文件"为循环引用 → 改为**串行 + 从后往前**替换。
5. **HTML 属性不能带换行**:`data-md` 属性值含换行会破坏 markdown-it 解析(整个文档错乱)→ 嵌入内容改用 **embeds 数组**(base64 编码注入,`const mmngEmbeds = JSON.parse(decodeURIComponent(escape(atob("..."))))`),标签只留 `data-index`。

### 3.2 块提取 `extractBlock`(最曲折的部分)
Obsidian 块引用有**多种形态**,需要分别处理:
- **独立 id 行**(`^id` 单独一行,块在 id 上方,如 ad-note 代码块)→ 向上扩展(含围栏代码块)
- **行尾 id**(`内容 ^id`,块从该行开始)→ **向上不扩展**,只向下
- **向下扩展**:只含**缩进比 id 行更深**的行(嵌套列表子项);**同级列表项是新的块**,排除
- **列表块**:列表标记行 + 缩进行连续识别
- 块边界:空行 / 标题 / 普通段落 / 围栏代码块

验证场景(全部通过):ad-note、首行 id + 子项 + 同级排除、中间层级 id 只向下、独立 id 向上含列表/代码块。

### 3.3 导出 HTML 模板的转义坑(重要!)
- **模板字符串里不能写 `</script>`**:webpack/esbuild 会转义成 `<\/script>`,若 TS 源里写普通 `</script>`,构建产物转义层数错乱 → 生成的 HTML 里 script 标签不闭合 → **整页 `Invalid or unexpected token`**。
- **模板 JS 里避免反斜杠转义序列**(`\\s`、`\n` 等):esbuild 编译模板时二次转义会破坏生成代码 → 用 `String.fromCharCode(96/10)` 代替反引号/换行,`indexOf/slice` 代替正则。
- **注释里不能有反引号**:模板字符串内的注释含 ```` ``` ```` 会提前终止模板字符串。
- 嵌入内容(base64)与转义安全:`toJsString` / `escapeHtml` 的使用边界要清楚。

### 3.4 其他
- **callout 样式**:导出时探针 `.callout` 元素,`getComputedStyle` 提取真实样式(背景/边框/圆角/标题),生成 `.mmng-callout` CSS 注入模板。
- **正文字体**:读 `--font-text-override` → `--font-text` → body fontFamily。
- **图片**:Obsidian `app://` 协议导出后不可用 → `app.vault.readBinary` 转 base64;宽度优先级 `|参数` > 全局 `htmlImageWidth` 设置。
- **pnpm 11**:`patchedDependencies`/`overrides`/`allowBuilds` 迁移到 `pnpm-workspace.yaml`(见 5.2)。
- **webpack-cli 6 + Node 22**:`.mts` 配置无法加载 → `webpack.config.js`(纯 JS 等价物)。
- **markmap 折叠**:`payload.fold` 不会被 `setData(initialExpandLevel: -1)` 清除 → 静态导出需 `clearFolds`(旧方案遗留,当前 HTML 导出不涉及)。

## 4. 当前代码状态

- `src/rendering/screenshot.ts`:仅 `downloadHtml`(约 500 行,含预处理/模板/工具)
- `src/rendering/renderer-tab.ts`:仅 `downloadHtml`(**动态 import** 懒加载导出模块)
- `src/views/view.ts`:菜单仅 "Export as HTML"(`file-code` 图标)
- `src/translation/{en,zh-simplified,zh-traditional}.ts`:`menu.export.html`
- `package.json`:已移除 `html-to-image`(PNG 方案遗留)
- 验证脚本:`test-embed-e2e.mjs`(预处理 + 块提取 + markmap 转换全链,mock Obsidian)、`test-preprocess.mjs`(纯函数)

## 5. 环境/构建备忘

```bash
pnpm install                 # 需要 pnpm-workspace.yaml 存在(pnpm 11)
pnpm run build               # webpack --mode production;产物 main.js
node test-embed-e2e.mjs      # 回归测试
node test-preprocess.mjs     # 纯函数测试
```

### 5.1 构建环境(相对原项目改动)
- `webpack.config.mts` → `webpack.config.js`(Node < 23.6 无法加载 .mts)
- `pnpm-workspace.yaml`(pnpm 11 配置迁移)

### 5.2 `pnpm-workspace.yaml`
```yaml
patchedDependencies:
  obsidian: patches/obsidian.patch
overrides:
  callbag: ^1.5.1
allowBuilds:
  esbuild: true
```

## 6. 发布待办(未执行)

- [ ] `manifest.json`:按发布方式更新(id/name/version/description/minAppVersion/author)
- [ ] `versions.json`:新版本映射(社区发布需要)
- [ ] `README.md`:更新功能说明(HTML 导出)、"More options" 菜单章节(删 Copy screenshot)、截图、badges
- [ ] 确认 LICENSE 与原作者版权(本仓库 fork 自 verocloud/obsidian-mindmap-nextgen,发布前检查许可)
- [ ] 发布前重新 `pnpm run build`(main.js 是编译产物)

## 7. 已知限制(可接受的降级)

- 导出的 HTML **需联网**(CDN:d3/markmap/katex)
- callout 的 Obsidian 特有语法(`> [!note]` 等)按 markdown-it 标准渲染;`ad-note` 围栏转 callout 样式
- 图片转 base64 → HTML 文件较大(照片级图片会明显增大)
- 打开者的电脑没有用户正文字体时回退系统字体
