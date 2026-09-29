# ASTaria

**让想做的事，落到真正有空的时间里。**

ASTaria 是一款本机优先的个人时间与事项应用。和析熙聊作业、计划或心愿，把任务放进课程和日常活动之间的真实空档，再从工作台开始专注。

当前版本：**0.1.0-beta.5** · macOS 13+ · Apple Silicon（arm64）

[下载最新版本](https://github.com/Wason-dev/ASTaria/releases) · [安装说明](docs/INSTALL.md) · [更新记录](CHANGELOG.md) · [功能详情](docs/FEATURES.md)

## 看看 ASTaria

<!-- Screenshots are captured with fictional, isolated demonstration data. -->
![黑洞首页：当前事项与析熙入口](docs/images/home.png)
![日程：课程、任务与空档同屏查看](docs/images/planner.png)
![余时：展开心愿输入区，与析熙理清第一步](docs/images/free-time.png)

- **析熙**：理解请求、读取空档、记录与安排，修改留下可核对和撤销的回执。支持 DeepSeek API 与本机兼容模型。
- **日程**：课程、固定活动、任务时段与截止一起查看，支持单双周课表。
- **工作台**：从现在能开始的事项进入专注，保存步骤和下次继续的线索。
- **余时与弦轨**：先把心愿聊清楚，再选择是否加入自动安排；为持续目标留出练习时间，在地平线里整理日期、分组和顺序。

## 安装

1. 从 [Releases](https://github.com/Wason-dev/ASTaria/releases) 下载 `mac-arm64-adhoc.dmg`，打开后把 **ASTaria** 拖入应用程序。
2. 第一次打开若被 macOS 拦截，按[安装说明](docs/INSTALL.md)处理。本版使用 ad-hoc 签名，尚未 Apple 公证。
3. 打开「设置 → 析熙」连接模型，然后录入课程、事项和可用时间。

设置中可检查、下载并安装 GitHub 更新。beta.5 起，自动安装还会验证内置公钥对应的发布清单签名。Windows、Intel Mac、Android 暂无安装包。

## 数据与隐私

事项、日程、对话和记忆保存在运行者的 Mac；API Key 存于 macOS 钥匙串。使用云端模型时，完成本次请求所需的上下文会发给所选服务；本地模型需自行运行。

数据目录为 `~/Library/Application Support/ASTaria`。可在设置中导出备份；更新前建议备份。系统提醒需要通知授权，显示内容遵循 macOS 预览与专注模式设置。详见[安全说明](SECURITY.md)。

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

CI 自动执行源码测试、桌面网页构建、许可清单和版本文档检查。隔离 UI 验证需安装 Google Chrome（可用 `CHROME_BINARY` 指定路径），会自动创建临时浏览器和测试数据，结束后清理；也可在 Actions 中手动运行「UI Verifications」。原生通知显示和实际 GPU 帧率仍需设备验证。

## 项目结构

| 目录 | 用途 |
| --- | --- |
| `src/` | React 界面、日程模型与黑洞渲染 |
| `server/` | SQLite、本机 API、析熙与排程 |
| `desktop/` | Electron、提醒与更新安装 |
| `scripts/` | 测试、隔离页面验证、打包工具 |
| `docs/` | 功能、安装与版本说明 |

详细开发与打包说明见[功能与开发文档](docs/FEATURES.md)。遇到问题请提交 [Bug report](https://github.com/Wason-dev/ASTaria/issues/new?template=bug_report.yml)，附版本、系统和复现步骤，避免上传密钥、课表或私密聊天。

## 许可

源码采用 [Apache-2.0](LICENSE)，第三方组件保留各自许可，见 [THIRD_PARTY_NOTICES.txt](THIRD_PARTY_NOTICES.txt)。许可证不授予 ASTaria 名称与标识的商标使用权，见 [NOTICE](NOTICE)。
