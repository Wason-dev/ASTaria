# ASTaria

**让时间有引力**

ASTaria 是一款本机优先的个人时间与事项应用。和析熙聊作业、计划或心愿，把任务放进课程和日常活动之间的真实空档，再从工作台开始专注。

当前版本：**BetaX · 0.1.0-beta.10**。macOS 13+ Apple Silicon（arm64）内测版，新增 Windows x64 试验版和两种无需自建服务器的加密目录同步。Windows 10 已实测，Windows 11 尚未验收。

[下载最新版本](https://github.com/Wason-dev/ASTaria/releases) · [安装说明](docs/INSTALL.md) · [更新记录](CHANGELOG.md) · [功能详情](docs/FEATURES.md) · [界面与交互规范](docs/UI_DESIGN_SYSTEM.md)

## 看看 ASTaria

截图使用虚构演示数据。

**从一句话，到可核对、可撤销的安排。** 析熙把实验报告记为事项并排入今晚 18:00–18:45；展开的变更回执列出截止、预计用时和已排时段，「撤销创建与安排」可一并撤回本次写入。聊天与当天日历就在同一张首页里。

![首页展开：执行结果、变更明细与撤销按钮，旁边同步显示当天安排](docs/images/home-receipt.png)

**黑洞首页**：收起对话后，回到当前事项与析熙入口。

![黑洞首页：当前任务为整理实验数据](docs/images/home.png)

**日程**：课程、当天任务、真实空档与待安排事项一起查看。

![日程周视图：已有课程和任务，当天剩余空档与两项待安排事项](docs/images/planner.png)

**余时**：三个持续目标，未来七天已安排 4 小时 25 分钟；每个目标的频率、单次时长和已排次数都有迹可循。

![余时：编程、英语阅读和速写目标，以及实际排入日历的练习时段](docs/images/free-time.png)

**弦轨**：在真实日期的地平线上按组查看、调整和保存安排；组多时沿可见中轴翻页。

![弦轨：明天的任务组沿地平线展开，屏内箭头浏览其余组](docs/images/horizon.png)

- **析熙**：理解请求、读取空档、记录与安排，修改留下可核对和撤销的回执。支持 DeepSeek API 与本机兼容模型。
- **联网搜索（可选）**：设置中明确打开后，析熙可用 DeepSeek 的独立搜索通道查找最新公开资料；只发送查询词，关闭时不会联网，本地模型正文仍留在本机。
- **日程**：课程、固定活动、任务时段与截止一起查看，支持单双周课表。
- **工作台**：从现在能开始的事项进入专注，保存步骤和下次继续的线索。
- **余时与弦轨**：先把心愿聊清楚，再选择是否加入自动安排；为持续目标留出练习时间，在地平线里整理日期、分组和顺序。

## 安装

1. 从 [Releases](https://github.com/Wason-dev/ASTaria/releases) 下载 `ASTaria-0.1.0-beta.10-mac-arm64-adhoc.dmg`，打开后把 **ASTaria** 拖到 **Applications 快捷方式**；DMG 只提供指向 `/Applications` 的入口，不会自动复制 App。
2. 第一次打开若被 macOS 拦截，按[安装说明](docs/INSTALL.md)处理。本版使用 ad-hoc 签名，尚未 Apple 公证。
3. 首次启动按引导选择外观与个性，可导入 API Key，也可稍后在「设置 → 析熙」连接模型；然后录入课程、事项和可用时间。

macOS 设置中可检查、下载并安装 GitHub 更新，并验证内置公钥对应的发布清单签名。Windows 下载 `ASTaria-0.1.0-beta.10-win-x64-setup.exe` 或 `ASTaria-0.1.0-beta.10-win-x64-portable.zip`；ZIP 需完整解压后运行 `ASTaria.exe`。Windows 暂无自动更新和退出 App 后提醒，试验包未做代码签名。Intel Mac、Android 暂无安装包。

在「设置 → 数据 → 跨设备同步」建立或加入同步组，选择共享文件夹或用户已经共享的 Syncthing 目录。每台电脑使用独立 SQLite，目录只传递加密操作；加入设备需要同步密钥，API Key 不同步。可查看待处理冲突、最近检查时间和变更回执。Syncthing 的真实跨机文件传送、Windows 11、休眠、更多 DPI/多屏配置、长期大数据运行仍未验收；详见[功能边界](docs/FEATURES.md)和[路线图与验收矩阵](PROJECT_ROADMAP.md)。

## 数据与隐私

事项、日程、对话和记忆保存在运行者本机；API Key 在 macOS 使用钥匙串、Windows 桌面使用系统 DPAPI 保护。使用云端模型时，完成本次请求所需的上下文会发给所选服务；本地模型需自行运行。联网搜索是单独的显式开关，开启后只把查询词发送到 DeepSeek Anthropic 搜索端点，不把课表、事项、聊天或记忆拼入搜索请求。

macOS 数据目录为 `~/Library/Application Support/ASTaria`，Windows 为 `%APPDATA%\ASTaria`。同步不复制聊天、记忆、思考、本地模型路径或运行中的数据库。可在设置中导出备份；更新前建议备份。系统提醒需要通知授权，显示内容遵循 macOS 预览与专注模式设置。详见[安全说明](SECURITY.md)。

## 从源码运行

需要 Node.js **24.19+（24.x）**、npm；macOS 源码运行还需要 Command Line Tools。

```bash
npm ci
npm run dev
```

浏览器打开终端显示的本机地址。Vite 同时启动本机 API，单独托管静态文件不提供任务和模型服务。

```bash
npm test
npm run typecheck
npm run build:desktop
node scripts/verify-doc-versions.mjs
node scripts/run-ui-verifications.mjs --list
node scripts/run-ui-verifications.mjs
```

CI 自动执行源码测试、桌面网页构建、许可清单和版本文档检查。隔离 UI 验证需安装 Google Chrome（可用 `CHROME_BINARY` 指定路径），会自动创建临时浏览器和测试数据，结束后清理；也可在 Actions 中手动运行「UI Verifications」。原生通知显示与更多 GPU 的长期性能仍需设备验证；本版 Windows 10 单机帧率实测见[性能记录](docs/PERFORMANCE.md)。README 截图可用 `node scripts/capture-readme.mjs` 重新生成到 `artifacts/readme-capture/`；它使用虚构对话与内存数据库，验证真实保存和撤销，不调用在线模型。

## 项目结构

| 目录 | 用途 |
| --- | --- |
| `src/` | React 界面、日程模型与黑洞渲染 |
| `server/` | SQLite、本机 API、析熙与排程 |
| `desktop/` | Electron、提醒与更新安装 |
| `scripts/` | 测试、隔离页面验证、打包工具 |
| `docs/` | 功能、安装与版本说明 |

详细开发与打包说明见[功能与开发文档](docs/FEATURES.md)。遇到问题请提交 [Bug report](https://github.com/Wason-dev/ASTaria/issues/new?template=bug_report.yml)，附版本、系统和复现步骤，避免上传密钥、课表或私密聊天。

## BetaX · 0.1.0-beta.10

- **三项修复**：假期显示正确标签；首次设置假期保留或生成可安排时间；析熙默认显示当前阶段与一行简短工具说明，完整思考仍可展开和复制。
- **加密目录同步**：共享文件夹与 Syncthing 目录共用追加式 AES-256-GCM 操作协议；同字段冲突可见、删除有墓碑、锁定与时间冲突重新校验，支持重复、乱序和断点恢复。
- **Windows 试验版**：提供当前用户安装 EXE 和 portable ZIP，采用独立数据目录与系统密钥保护。Windows 10 真实桌面启动和 Mac ↔ Windows 操作文件往返已通过；Windows 11 未验收。
- **首次设置**：新增「ASTaria 推荐」自动画质，也可手动独立选择 30/45/60/90/120 FPS 与最高/高/轻量/兼容画质；空工作台可以直接继续教程。
- **Windows 体验**：简化窗口外壳，统一工作台与余时滚动条。默认玻璃合成路径显著改善实测帧率，精细折射仍可手动开启；具体视觉取舍和数据见[性能记录](docs/PERFORMANCE.md)。
- **发布一致性**：沿用 beta6 的版本目录命名，发布安装说明统一为小写 `install.txt`，完整 GSAP 许可与服务端依赖随包提供。

实际验证与限制见 [BetaX 发布说明](docs/RELEASE_NOTES_v0.1.0-beta.10.md)；安装包见 [BetaX Release](https://github.com/Wason-dev/ASTaria/releases/tag/v0.1.0-beta.10)。

## 许可

源码采用 [Apache-2.0](LICENSE)，第三方组件保留各自许可，见 [THIRD_PARTY_NOTICES.txt](THIRD_PARTY_NOTICES.txt)。许可证不授予 ASTaria 名称与标识的商标使用权，见 [NOTICE](NOTICE)。
