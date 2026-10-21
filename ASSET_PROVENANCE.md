# 资源来源与分发范围

- v1.0 图标成稿为 `design/icon/new/astaria-icon.svg`，采用银灰三瓣与 `#282828` 黑底；`astaria-icon-transparent.svg` 是同一图案的透明源。两份成稿保留原始路径、实色、描边和裁剪关系，没有渐变或嵌入位图。历史稿位于 `design/icon/old/`，不作为当前导出源。
- `scripts/generate-icons.mjs` 从成稿直接导出网页、macOS、Windows、Android 与 iOS 资源；网页主 SVG 与黑底成稿逐字节相同。ICNS 由桌面打包器封装。Android 状态栏通知和系统主题图标采用平台要求的白色 alpha 遮罩，主图保留银灰颜色。导出规格见 [图标说明](design/icon/README.md)。
- 黑洞与弦轨由项目现有 React、Canvas、Three.js 渲染；历史查阅 React Bits、Aceternity、Anime.js 作为动效参考，没有引入这些组件依赖。相关依赖的实际许可证正文见 `THIRD_PARTY_NOTICES.txt`。
- 应用二进制另附 ASTaria 的 Apache-2.0 LICENSE、NOTICE、Electron 的 LICENSE 与 Chromium notices；生产依赖许可收集无缺失条目。该清单不等于所有列出的包都进入应用二进制。
- 分发资源不包含开发机器的路径或环境信息。

Windows 的 `public/astaria.ico` 从同一黑底成稿直接渲染 16/24/32/48/64/128/256 像素图层，用于 EXE 与 NSIS 安装/卸载图标；macOS App 与提醒辅助程序使用同一 ICNS。iOS App 图标为 1024 像素 RGB，不含 alpha。以上按黑底成稿导出的 macOS 与 Windows 记录保留为默认导出基线。

2026-10-14 的透明底图标是**本地候选试用**，不是新的分发基线：主代理以 `design/icon/new/astaria-icon-transparent-2048.png`（2048×2048 RGBA）为源，保留原色与图案等比缩放导出 macOS ICNS 与 Windows ICO；图案以中心为基准放大约 10%（`glyphScale 1.1`），原轮廓未被裁掉、透明边缘保留，没有重绘、改色或新增渐变。只覆盖本机候选的 macOS App、提醒辅助程序与**应用程序目录里的 ASTaria 原生替身**（指向 `desktop-builds` 中 Mac 候选的原生 Finder alias；DMG 内的 `Applications` 只是系统文件夹快捷方式，没有替换系统文件夹图标），以及 Windows EXE 与 NSIS 安装/卸载图标。Android、iOS 与网站仍使用已选的黑底成稿，`scripts/generate-icons.mjs` 的默认导出也仍是黑底，既有 41 项黑底导出记录不变。透明源 PNG 是 Git 忽略的本地素材，不应 `git add -f` 或改动忽略规则，也没有被打进本地包，不属于公开分发资源清单；进入本地包的是导出后的透明 ICNS 与 ICO。Mac 本机候选签名与隔离冒烟通过，ICNS 11 档及 Windows EXE / NSIS setup 7 档资源的像素透明验证通过；Finder 显示仍由主代理核对，Windows 真机**尚未验收**；本轮仍为本地候选，没有公开发布、公开下载链接或公开更新签名清单。

## DMG 安装背景

`design/dmg/background.svg` 为项目内手工编写的深色、暖白与暖金安装提示；`background.png` 是同稿的 1800×1120、144 dpi 导出，对应 900×560 逻辑布局。没有使用生成式图片或外部背景素材。`scripts/dmg-layout.py` 仅写 staging 磁盘的 Finder 背景/窗口/图标元数据；`scripts/dmg-notes-icon.m` 为真实说明文件设置透明装饰图标，保留底部可打开的文字标签。隐藏 `.background`、`.DS_Store` 与说明文件图标资源只服务于 Finder 展示，不是安装脚本，不进入或改变 App 的签名资源。
