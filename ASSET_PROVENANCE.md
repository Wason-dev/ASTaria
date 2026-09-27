# 资源来源与分发范围

- 当前应用图标母版为项目维护的 `design/icon-vector/astaria-icon-layered.svg`；macOS SVG 与 `public/` 下六种 PNG 由 `scripts/generate-icons.mjs` 生成，ICNS 由打包器生成，SVG 没有嵌入位图。
- 黑洞与弦轨由项目现有 React、Canvas、Three.js 渲染；历史查阅 React Bits、Aceternity、Anime.js 作为动效参考，没有引入这些组件依赖。相关依赖的实际许可证正文见 `THIRD_PARTY_NOTICES.txt`。
- 应用二进制另附 ASTaria 的 Apache-2.0 LICENSE、NOTICE、Electron 的 LICENSE 与 Chromium notices；生产依赖许可收集无缺失条目。该清单不等于所有列出的包都进入应用二进制。
- 分发资源不包含开发机器的路径或环境信息。
