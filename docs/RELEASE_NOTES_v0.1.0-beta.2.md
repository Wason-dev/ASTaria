# ASTaria v0.1.0-beta.2

ASTaria macOS Apple Silicon 小范围内测版，面向 macOS 13 或更新版本的 Apple Silicon（M 系列）设备。不支持 Intel Mac。

这是 **ad-hoc 签名、未经 Apple 公证的预发布版本**，适合受邀测试，不代表正式公开发行版。

## 本次更新

- 修复全屏模式下场景层隐藏系统鼠标的问题；全屏时鼠标保持可见，退出全屏后恢复正常交互。
- 增加回归检查，防止场景样式再次全局设置 `cursor: none`。
- 保留 beta.1 已验证的弦轨、模型等待状态、玻璃模式和本地数据边界。

## 验证

- `npm run typecheck`：通过
- `npm test`：1147 / 1147 通过
- `npm run build`：通过
- 桌面构建：通过
- 应用与 DMG：arm64、ad-hoc 签名、未公证；发布附件包含 SHA-256 和构建清单

## 安装

优先下载 `ASTaria-0.1.0-beta.2-mac-arm64-adhoc.dmg`，退出旧版后将 App 拖入 Applications（应用程序）。安装步骤和打不开时的命令行处理见 [`docs/INSTALL.md`](./INSTALL.md)。

如果 macOS 阻止打开，请先确认安装包来自可信的测试分发渠道，再按安装说明处理下载隔离标记。ad-hoc 签名不证明发布者身份，也不替代 Developer ID 签名和 Apple 公证。

## 数据与隐私边界

- 安装包不包含开发者的课表、事项、聊天记录、记忆、数据库或模型密钥。
- 应用数据默认保存在本机。首次使用请在设置中配置自己的模型连接，并在测试前导出备份。
- 不要在公开 issue、日志或截图中提交 API Key、数据库文件或个人日程。

## 反馈

提交问题前请附上复现步骤、系统版本、芯片型号和相关终端错误；请删除个人数据、数据库内容和密钥。安全问题请按 [`SECURITY.md`](../SECURITY.md) 的方式报告。
