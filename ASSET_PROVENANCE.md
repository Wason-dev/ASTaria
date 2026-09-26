# 资源来源与分发范围

- 当前应用图标母版为 `design/icon-vector/astaria-icon-layered.svg`；macOS SVG 与 `public/` 下六种 PNG 由 `scripts/generate-icons.mjs` 生成，ICNS 由打包器生成。SVG 没有嵌入位图。
- 原始视觉参考由用户提供，为即梦生成的三瓣图标。2026-09-26 用户确认转换后的 SVG 可以分发，原始参考图不分发。`design/**/*.png`（含参考图对照及过程预览）仅留本地，不属于发布资源。
- 黑洞与弦轨由项目现有 React、Canvas、Three.js 渲染；历史查阅 React Bits、Aceternity、Anime.js 作为动效参考，没有引入这些组件依赖。相关依赖的实际许可证正文见 `THIRD_PARTY_NOTICES.txt`。
- 应用二进制另附 Electron 的 LICENSE 与 Chromium notices；生产依赖许可收集包含 96 条记录，无缺失条目。该清单不替代主项目许可证，也不等于所有列出的包都进入应用二进制。
- 开发截图、录屏、性能 trace、DSH 审计及机器路径不属于分发资源。当前源码树排除 `artifacts/`，旧历史仍需要按 `PUBLIC_READINESS.md` 处理。
