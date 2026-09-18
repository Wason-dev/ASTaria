# ASTaria

React + Vite + TypeScript + Three.js 应用，默认进入黑洞首页，包含本地事项、日程概览和专注工作台。
原有业务界面可从 `/#/app` 进入，析熙对话和自动排程尚未接入新界面。

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
npm run build:preview # 带视觉自定义与示例数据入口的设计预览构建
npm run preview # 预览生产构建产物
npm run typecheck
npm test       # 全部纯逻辑测试，需要 Node.js 24.7+（建议 Node 24 LTS）
```

测试直接使用 Node 的 TypeScript 类型剥离与模块解析钩子，无需额外测试框架。浏览器验收与纯逻辑测试分开运行：在独立临时 Chrome 测试配置上开放 CDP 9233，再运行 `node scripts/verify-workbench.mjs`。该脚本会清理测试浏览器的本地数据，不能连接日常使用的浏览器配置。正式构建验收用 `WORKBENCH_PRODUCTION=1 node scripts/verify-workbench.mjs`，设计预览验收先运行 `npm run build:preview`。

视觉调参和示例入口仅在开发服务器或 `build:preview` 中启用，正式构建不读取已保存的调试外观参数。专注与休息时长属于正式功能，两种构建均可调整。

## 结构

```
index.html            入口 HTML
vite.config.ts        Vite + Tailwind + PWA 配置（manifest 名称：ASTaria）
tsconfig.json         TypeScript 配置
src/main.tsx          React 挂载入口
src/App.tsx           原有业务界面
src/home/             黑洞首页、析熙面板与日程概览
src/workbench/        专注工作台、Upcoming DDL 与开发预览工具
src/prototype/        黑洞渲染核心
src/index.css         Tailwind 入口
src/vite-env.d.ts     Vite 客户端类型
public/               静态资源与 ASTaria 图标
```

构建后 `dist/` 中会生成 `manifest.webmanifest` 与 `sw.js`（generateSW 产物）。
