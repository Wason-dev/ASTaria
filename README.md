# ASTaria

**让时间有引力**

ASTaria 是一款本机优先的个人时间与事项应用。和析熙聊作业、计划或心愿，把任务放进课程和日常活动之间的真实空档，再从工作台开始专注。

当前版本：**Beta11 · 0.1.0-beta.11**，已于 **2026-10-08** 发布。源码已合并到 `main`；[本版 Release](https://github.com/Wason-dev/ASTaria/releases/tag/v0.1.0-beta.11) 提供 macOS 13+ Apple Silicon DMG、Windows x64 安装 EXE 与便携 ZIP，两端均从干净提交 `23c8010` 构建。Windows 仍为未签名试验版，切页与展开聊天仍存在卡顿，体验验收未通过；当前 Windows 包的重新安装与交互、本版自动升级/回退、Windows 11 均未实机验收。BetaX 的加密目录同步能力沿用，多设备传输验收仍待完成。

[下载最新版本](https://github.com/Wason-dev/ASTaria/releases) · [安装说明](docs/INSTALL.md) · [更新记录](CHANGELOG.md) · [功能详情](docs/FEATURES.md) · [界面与交互规范](docs/UI_DESIGN_SYSTEM.md)

本次发布通过 macOS 全量测试 1,508 项、Windows 核心测试 124 项及 Windows 打包测试 70 项（测试集重叠，不累加）；Mac 成品完成隔离原生启动检查，全部 9 个 Release 附件的大小与 SHA-256、两端清单签名和更新器识别均已核对。完整证据与限制见 [Beta11 发布说明](docs/RELEASE_NOTES_v0.1.0-beta.11.md)。

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

当前包名与步骤见[安装说明](docs/INSTALL.md)：`ASTaria-0.1.0-beta.11-mac-arm64-adhoc.dmg`（macOS）与 `ASTaria-0.1.0-beta.11-win-x64-setup.exe` / `ASTaria-0.1.0-beta.11-win-x64-portable.zip`（Windows x64）。请从 [Beta11 Release](https://github.com/Wason-dev/ASTaria/releases/tag/v0.1.0-beta.11) 下载并核对 SHA-256。

1. 把 DMG 里的 **ASTaria** 拖到 **Applications 快捷方式**；DMG 只提供指向 `/Applications` 的入口，不会自动复制 App。
2. 第一次打开若被 macOS 拦截，按[安装说明](docs/INSTALL.md)处理。当前包使用 ad-hoc 签名，尚未 Apple 公证。
3. 首次启动按引导选择外观与个性，可导入 API Key，也可稍后在「设置 → 析熙」连接模型；然后录入课程、事项和可用时间。

macOS 设置中可检查、下载并安装 GitHub 更新，并验证内置公钥对应的发布清单签名。Windows 的 ZIP 需完整解压后运行 `ASTaria.exe`。从 Beta11 起，Windows 标准安装版（`%LOCALAPPDATA%\Programs\ASTaria\ASTaria.exe`）可在「设置 → 通用 → App 更新」检查、下载并校验发布清单的 Ed25519 签名与 SHA-256，然后退出 App、静默安装并重启；自动检查默认开启、最多每 6 小时一次，也可手动检查或关闭。便携版（`portable.zip`）与其它非标准安装位置只能手动更新，退出 App 后运行新下载的安装包。Windows 试验包仍未做代码签名。Windows 10 的真实自动升级与失败回退、Windows 11 都尚未验收。Intel Mac、Android 暂无安装包。

旧 Beta11 本地测试包在 Windows 应用内更新加入之前就已冻结，不应作为当前版本使用；BetaX 的 Windows 试验版也从未提供应用内更新。从 BetaX 升到 Beta11 的第一次仍需手动下载并运行新的 `setup.exe` 或解压新的 portable ZIP。

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

## Beta11 · 0.1.0-beta.11（预发布）

本版同时优化 macOS 和 Windows，保持现有画质、分辨率、采样和特效参数。

- 帧率档位按原有省电设计分区生效：首页与聊天沿用所选帧率，工作区的黑洞与环境渲染最高 60 FPS；30/45 档不会被升档，画质独立、不随帧率下调，返回首页即恢复所选帧率。本版保留该上限并修复高刷时间戳波动造成的误跳帧。
- 聊天展开减少重复几何更新和相同位移贴图的 PNG 编码。
- 聊天到达原定可输入位置后，不再额外等待相机弹簧完全停稳；保留动画与画质。Mac 原生对照消除约 1.1 秒额外等待，Windows 独立验证待完成。
- 移除无效玻璃合成与不产生可见效果的 GPU 工作；退出后的隐藏工作区跳过样式和布局，返回时保留状态。
- 两端分别记录动态帧间隔，并核对实际 GPU 像素和深浅主题/玻璃截图；不再仅用静置后的平均 FPS 判断流畅度。
- 旧本地包已通过安装/启动与内容校验；冻结时源码测试 1,494 项、Windows 专项 63 项、浏览器帧率设置专项 52 项通过。2026-10-06 当前源码测试 1,508 项通过，Mac 新一轮 20 项动态矩阵与六组真实输入检查通过；Windows 本轮修复待独立实测，构建来源和逐项验收见 Beta11 说明。

具体改动、验证和未完成项见 [Beta11 说明](docs/RELEASE_NOTES_v0.1.0-beta.11.md)与[性能记录](docs/PERFORMANCE.md)。必须保留的取舍见[省电与渲染决策记录](docs/POWER_AND_RENDERING_DECISIONS.md)。Windows 首次展开聊天的偶发长帧和切页卡顿尚未解决，手动精细折射仍高开销。Windows 11、更多 GPU/DPI/多屏、休眠恢复、长期功耗、真实模型下载与 Syncthing 实际跨机传送也仍未验收。

## 许可

源码采用 [Apache-2.0](LICENSE)，第三方组件保留各自许可，见 [THIRD_PARTY_NOTICES.txt](THIRD_PARTY_NOTICES.txt)。许可证不授予 ASTaria 名称与标识的商标使用权，见 [NOTICE](NOTICE)。
