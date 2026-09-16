# ASTaria

最小可运行的脚手架：React + Vite + TypeScript + Tailwind CSS + vite-plugin-pwa。
当前不包含任何业务 UI、状态管理、持久化或领域模型，仅提供可构建、可安装为 PWA 的起点。

## 技术栈

| 关注点 | 方案 |
| --- | --- |
| 框架 | React 19 + TypeScript |
| 构建 | Vite（`tsc --noEmit && vite build`） |
| 样式 | Tailwind CSS（`@tailwindcss/vite` 插件，`src/index.css` 中 `@import "tailwindcss"`） |
| PWA | vite-plugin-pwa，`strategies: 'generateSW'`（Workbox 生成 service worker），`registerType: 'autoUpdate'` |

## 命令

```bash
npm install     # 安装依赖
npm run dev     # 本地开发服务器
npm run build   # 类型检查 + 生产构建（输出到 dist/）
npm run preview # 预览生产构建产物
npm run typecheck
```

## 结构

```
index.html            入口 HTML
vite.config.ts        Vite + Tailwind + PWA 配置（manifest 名称：ASTaria）
tsconfig.json         TypeScript 配置
src/main.tsx          React 挂载入口
src/App.tsx           占位组件（无业务逻辑）
src/index.css         Tailwind 入口
src/vite-env.d.ts     Vite 客户端类型
public/               静态资源与 ASTaria 图标
```

构建后 `dist/` 中会生成 `manifest.webmanifest` 与 `sw.js`（generateSW 产物）。
