# ASTaria 图标

- `astaria-icon-layered.svg`：当前应用图标的可编辑矢量母版，对照用户选定的三瓣层叠参考图描摹；包含石墨外壳、银色分层、中央黑洞和细金线，无嵌入位图。
- `astaria-icon-macos.svg`：从当前母版生成的 macOS 版，增加白色圆角底板、透明外边距和轻阴影；全部为矢量。
- `astaria-icon.svg`、`astaria-icon-transparent.svg`：保留的旧版原稿、透明图案和预览，不是当前默认生成源。

2026-09-25 修正右下瓣：银色主曲面及各层共享下方外轮廓，去掉末端向内回钩和多余黑缝，并统一分层曲线。其他两瓣与中央黑洞保留。已检查完整图案及 512、128、64、32 像素图标。

`scripts/generate-icons.mjs` 默认从 `astaria-icon-layered.svg` 生成 `public/` 中的六个 PNG，并更新 macOS SVG。它需要可用的 Sharp 图形工具，仅用于生成资源，不是 App 的运行依赖：

```bash
node scripts/generate-icons.mjs --sharp /absolute/path/to/sharp/index.mjs
```

若开发环境本身可导入 `sharp`，可省略 `--sharp`。可用 `--source` 选择其他 SVG，用 `--out`、`--macos-svg` 指定临时输出以先行预览。

桌面打包器使用 `public/astaria-icon-1024.png` 生成 16–1024 像素及 Retina ICNS；macOS 不会替这个 ICNS 自动裁圆角。网页及 Apple touch 使用满幅白底，maskable 版本另外缩小图案以满足中央安全圆，不能直接复用桌面透明边距版。

用户已确认可分发转换后的 SVG 及其应用图标产物。原始即梦参考图、含参考图的对照与本地设计 PNG 不进入仓库或 Release；详见 [资源说明](../../ASSET_PROVENANCE.md)。
