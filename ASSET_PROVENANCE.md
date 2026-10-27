# 资源来源与分发范围

- v1.0 图标成稿为 `design/icon/new/astaria-icon.svg`，采用银灰三瓣与 `#282828` 黑底；`astaria-icon-transparent.svg` 是同一图案的透明源。两份成稿保留原始路径、实色、描边和裁剪关系，没有渐变或嵌入位图。历史稿位于 `design/icon/old/`，不作为当前导出源。
- `scripts/generate-icons.mjs` 从成稿直接导出网页、macOS、Windows、Android 与 iOS 资源；网页主 SVG 与黑底成稿逐字节相同。ICNS 由桌面打包器封装。Android 状态栏通知和系统主题图标采用平台要求的白色 alpha 遮罩，主图保留银灰颜色。导出规格见 [图标说明](design/icon/README.md)。
- 黑洞与弦轨由项目现有 React、Canvas、Three.js 渲染；历史查阅 React Bits、Aceternity、Anime.js 作为动效参考，没有引入这些组件依赖。相关依赖的实际许可证正文见 `THIRD_PARTY_NOTICES.txt`。
- 应用二进制另附 ASTaria 的 Apache-2.0 LICENSE、NOTICE、Electron 的 LICENSE 与 Chromium notices；生产依赖许可收集无缺失条目。该清单不等于所有列出的包都进入应用二进制。
- 分发资源不包含开发机器的路径或环境信息。

Windows 的 `public/astaria.ico` 从同一黑底成稿直接渲染 16/24/32/48/64/128/256 像素图层，用于 EXE 与 NSIS 安装/卸载图标；macOS App 与提醒辅助程序使用同一 ICNS。iOS App 图标为 1024 像素 RGB，不含 alpha。macOS 与 Windows 均以按黑底成稿导出的资源为默认基线。

透明底桌面图标是 2026-10-14 的本地素材试验，未成为分发基线；桌面导出与分发已统一使用黑底成稿。透明源 `astaria-icon-transparent.svg` 仍用于 Android adaptive 前景、通知与主题遮罩及启动画面合成。透明 PNG 母版为 Git 忽略的本地文件，不 `git add -f`、不改忽略规则，也不进入仓库或分发产物。

## DMG 安装背景

`design/dmg/background.svg` 为项目内手工编写的深色、暖白与暖金安装提示；`background.png` 是同稿的 1800×1120、144 dpi 导出，对应 900×560 逻辑布局。没有使用生成式图片或外部背景素材。`scripts/dmg-layout.py` 仅写 staging 磁盘的 Finder 背景/窗口/图标元数据；`scripts/dmg-notes-icon.m` 为真实说明文件设置透明装饰图标，保留底部可打开的文字标签。隐藏 `.background`、`.DS_Store` 与说明文件图标资源只服务于 Finder 展示，不是安装脚本，不进入或改变 App 的签名资源。
