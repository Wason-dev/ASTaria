# ASTaria

**让时间有引力**

ASTaria 是一款本机优先的个人时间与事项应用。和析熙聊作业、计划或心愿，把任务放进课程和日常活动之间的真实空档，再从工作台开始专注。

当前版本：**Beta12 · 0.1.0-beta.12**。本版面向 macOS 13+ Apple Silicon 与 Windows x64，完善聊天回执、网页直取、图片附件、提醒改期和弦轨排程，并调整工作区背景的省电策略。Windows 仍为未签名试验版：切页与展开聊天的卡顿尚未完成体验验收，Windows 11、本版实机安装及真实自动升级/回退也未验收。多设备同步继续沿用加密目录协议，实际 Syncthing 传输与后续目录优化仍待完成。

[下载 Beta12](https://github.com/Wason-dev/ASTaria/releases/tag/v0.1.0-beta.12) · [安装说明](docs/INSTALL.md) · [更新记录](CHANGELOG.md) · [功能详情](docs/FEATURES.md) · [界面与交互规范](docs/UI_DESIGN_SYSTEM.md)

源码全量测试 **1,531 项**通过；回执交互完成 **13 项**隔离浏览器检查，覆盖主题、材质、窄屏、刷新与真实撤销；新版演示截图通过 **58 项**检查，包含调休与实际保存、撤销。网页直取已实际取得本仓库正文。构建来源、发布附件与验收限制统一记录在 [Beta12 发布说明](docs/RELEASE_NOTES_v0.1.0-beta.12.md)，自动化测试不代替真实模型或设备体验验收。

## 看看 ASTaria

以下画面来自真实页面和虚构演示数据，不含个人课表、聊天或密钥。

**一句话，记下事项并安排到真实空档。** 实验报告明天截止，今晚 18:00–18:45 完成；聊天保留析熙的回复，下方回执核对截止、用时和安排，并可一并撤销创建与排程。

![首页展开：聊天、真实执行回执与当天日历](docs/images/home-receipt.png)

**黑洞首页**：收起对话，保留当天事项、日历与析熙入口。

![黑洞首页：当天安排与析熙入口](docs/images/home.png)

**日程周视图**：同一周展示假期、调休、课程、单日活动和已安排任务。10/5–10/6 放假，10/9 使用周三课表，10/10 周六使用周五课表；校庆活动与待安排事项仍独立保留。

![日程周视图：假期、周五与周六的临时课表、校庆活动及任务](docs/images/planner.png)

**调课当天**：查看 10/9 的周三课表、课程地点、已排任务和真实剩余空档，不用修改整个每周课表。

![日程日视图：10月9日临时使用周三课表](docs/images/planner-day.png)

**余时**：编程、英语阅读和速写三个持续目标，各自保留频率、单次时长、截止与实际排入日历的记录。

![余时：三个持续目标及未来日期的练习安排](docs/images/free-time.png)

**弦轨**：在真实日期上查看分组、调整顺序和换天，超过一屏的组沿中轴翻页；只改明天时，今天已满不会阻止保存。

![弦轨：明天的多组事项与日期、排序、保存入口](docs/images/horizon.png)

**工作台**：从现在可以开始的事项进入专注，同时查看截止、用时与近期任务。

![工作台：真实事项、近期截止与专注入口](docs/images/workbench.png)

## Beta12 的改动

- **聊天与回执**：部分操作失败时保留析熙正文，只在独立提示里列出「尚未完成」；成功内容放在可撤销回执中。排程日期和时刻在明细只显示一次。回复中断后重试不会重复写入。
- **直接读取网页**：打开「联网搜索」后，可让析熙读取完整 HTTP/HTTPS 链接；完整网址直接从本机抓取，普通关键词继续使用搜索通道。需要公开、可读取的 HTML 页面，不登录、不执行网页脚本。
- **聊天图片**：可附一张 PNG、JPEG 或 WebP（不超过 2 MB），随请求发给当前模型并保存在本机。需要支持视觉输入的模型，实际模型识图仍待验证。
- **提醒改期**：修改事项安排时间后，撤销旧预约并按新时间重建。macOS 可预约关闭 App 后的提醒；Windows 当前只有 App 内提醒摘要与状态，尚未支持系统弹窗和原生预约。
- **弦轨与余时**：排程只重新计算实际改动的日期；复用相同地平线采样，保留曲线公式和显示细节。
- **两端省电策略**：推荐首页/聊天目标 60 FPS，工作台、余时、日程、设置的黑洞与环境渲染最高 30 FPS；手动首页/聊天仍可选 30/45/60/90/120，返回首页恢复。画质独立，30 FPS 会影响背景动效顺滑度，不能算作画质不变的性能提升。
- **发布与文档**：保留历版性能证据和取舍记录，刷新演示截图，统一安装说明及第三方许可。几何未变时复用玻璃位移图；CSS 背景取样仍随运动背景变化，尚无独立可变刷新率玻璃控制器或全局静置 0 FPS。

具体实现、测试与未完成项见 [Beta12 发布说明](docs/RELEASE_NOTES_v0.1.0-beta.12.md)、[性能记录](docs/PERFORMANCE.md)与[省电决策](docs/POWER_AND_RENDERING_DECISIONS.md)。搜索没有可核实正文时的固定兜底仍待改进，临时调课后自动重排全部余时也未完成。

## 安装

macOS 下载 `ASTaria-0.1.0-beta.12-mac-arm64-adhoc.dmg`；Windows x64 下载 `ASTaria-0.1.0-beta.12-win-x64-setup.exe` 或 `ASTaria-0.1.0-beta.12-win-x64-portable.zip`。从 [Beta12 Release](https://github.com/Wason-dev/ASTaria/releases/tag/v0.1.0-beta.12) 获取校验文件，并按[安装说明](docs/INSTALL.md)核对 SHA-256。

1. macOS：把 DMG 中的 **ASTaria** 拖到 **Applications 快捷方式**，再从应用程序打开。DMG 只提供指向 `/Applications` 的入口。当前包使用 ad-hoc 签名，尚未 Apple 公证。
2. Windows：运行 `setup.exe`，默认安装到当前用户目录，不需要管理员权限；便携 ZIP 须完整解压，再运行其中的 `ASTaria.exe`。Windows EXE 尚未代码签名。
3. 首次启动选择个性、外观、帧率与画质。「ASTaria 推荐」从最高画质开始按持续负载调整；手动画质保持固定。模型连接可稍后设置，然后录入课程、事项和可用时间。

macOS 与 Windows 标准安装版可在「设置 → 通用 → App 更新」检查、下载并验证发布清单的 Ed25519 签名、大小与 SHA-256，再安装并重启。Windows 便携版和非标准安装位置需手动更新；BetaX 的 Windows 版没有应用内更新，首次升级须手动运行新安装包。更新不覆盖本机用户数据，更新前建议导出备份。Windows 真实自动升级和失败回退未实机验收。Intel Mac、iOS、Android 暂无安装包。

在「设置 → 数据 → 跨设备同步」建立或加入同步组，选择共享文件夹或已经配置的 Syncthing 目录。每台设备使用独立 SQLite，目录只传递加密操作；加入需要同步密钥，API Key、聊天与图片不同步。变更回执只证明本机处理结果。更多硬件、多屏、休眠恢复、长期功耗和 Syncthing 实际传输未验收，详见[功能边界](docs/FEATURES.md)。

## 数据与隐私

事项、日程、对话、图片和记忆保存在本机。API Key 在 macOS 使用钥匙串、Windows 桌面使用 DPAPI 保护。云端模型收到本次请求必要的上下文及所附图片；本地模型需自行运行，图像输入取决于模型能力。真实模型下载、推理、工具调用和识图尚未验收。

联网搜索默认关闭。开启后，关键词发送到 DeepSeek 搜索通道；完整网址由本机访问目标网站，不发送到关键词搜索服务。网页抓取拒绝私网与本机地址，目标网站仍能看到请求连接信息。模型上下文不会拼入独立搜索请求。

macOS 数据目录为 `~/Library/Application Support/ASTaria`，Windows 为 `%APPDATA%\ASTaria`。同步不复制聊天、图片、记忆、思考、本地模型路径或运行中的数据库。JSON 备份包含业务数据及图片，不含 API Key 和同步密钥；请妥善保护备份及另存的同步恢复密钥。系统提醒需要通知授权，送达受系统专注模式等限制。详见[安全说明](SECURITY.md)。

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

CI 执行源码测试、桌面网页构建、许可和版本文档检查。隔离 UI 验证使用 Google Chrome（可通过 `CHROME_BINARY` 指定），自动创建并清理测试数据；也可在 Actions 手动运行「UI Verifications」。README 截图通过 `node scripts/capture-readme.mjs` 生成到 `artifacts/readme-capture/`，使用虚构数据和内存数据库，并验证真实保存与撤销，不调用在线模型。测试统计及原生验收边界见版本说明。

## 项目结构

| 目录 | 用途 |
| --- | --- |
| `src/` | React 界面、日程模型与黑洞渲染 |
| `server/` | SQLite、本机 API、析熙与排程 |
| `desktop/` | Electron、提醒与更新安装 |
| `scripts/` | 测试、隔离页面验证、打包工具 |
| `docs/` | 功能、安装与版本说明 |

详细开发与打包说明见[功能与开发文档](docs/FEATURES.md)。问题请提交 [Bug report](https://github.com/Wason-dev/ASTaria/issues/new?template=bug_report.yml)，附版本、系统和复现步骤，避免上传密钥、课表或私密聊天。

## 许可

源码采用 [Apache-2.0](LICENSE)，第三方组件保留各自许可，见 [THIRD_PARTY_NOTICES.txt](THIRD_PARTY_NOTICES.txt)。许可证不授予 ASTaria 名称与标识的商标使用权，见 [NOTICE](NOTICE)。
