# ASTaria 1.0.0 安装说明

本文说明 ASTaria 1.0.0 的安装要求与操作。当前公开版本仍为 Beta12.1，其已发布信息见文末“历史公开版本”。Beta12.1 之后的版本变化见 [v1.0 发布说明](docs/RELEASE_NOTES_v1.0.0.md)。

## 平台与安装包

| 平台 | 安装形式 | 当前状态 |
| --- | --- | --- |
| macOS 13+ Apple Silicon（arm64） | DMG，拖入「应用程序」 | Developer ID 签名与 Apple 公证尚未完成 |
| Windows x64 | `setup.exe`（当前用户安装）或 portable ZIP | 未做 Authenticode 代码签名；未完成实机验证 |
| Android 手机 | 发布渠道待公布 | 随 1.0.0 首次发布，当前无公开安装包 |
| iOS（iPhone、iPad） | TestFlight / App Store 渠道待公布 | 随 1.0.0 首次发布，当前无 IPA 或 TestFlight 邀请 |

## macOS 13+ · Apple Silicon

系统要求：macOS 13 或更新版本，Apple Silicon（M 系列芯片）；不支持 Intel Mac。

1. 退出正在运行的旧版 ASTaria。
2. 打开下载的 DMG，把 ASTaria.app 拖到 Applications 快捷方式上，再从「应用程序」打开。
3. 安装后可推出磁盘映像。

1.0.0 的 Developer ID 签名与 Apple 公证尚未完成。如系统提示无法验证开发者，先正常尝试打开一次，再到「系统设置 → 隐私与安全性」为 ASTaria 选择「仍要打开」并按提示确认；不要关闭全系统安全设置。如需核对包内签名，可在终端运行：

```sh
/usr/bin/codesign --verify --deep --strict --verbose=2 "/Applications/ASTaria.app"
```

系统提醒：在「设置 → 通知」开启「关闭 App 后仍提醒」，按系统提示允许 ASTaria 提醒。预约交给 macOS，无需 App 常驻；覆盖未来 30 天内最近的 64 条，打开或恢复时补充。修改安排时间后会取消旧预约并按新时刻重建，完成或删除也会取消。免打扰、系统专注模式和关机会影响送达。

## Windows x64

运行 `setup.exe`，按提示安装后从开始菜单或安装目录启动，无需管理员权限，按当前用户安装到 `%LOCALAPPDATA%\Programs\ASTaria`。便携版须完整解压到新目录，再运行其中的 ASTaria.exe，不要只移动单个 EXE。

数据目录为 `%APPDATA%\ASTaria`；安装版与便携版共用当前用户数据。卸载会删除程序、快捷方式与卸载注册项，不删除用户数据。Windows 包未做 Authenticode 代码签名，是未签名试验包。该版本未完成实机验证，此前记录的切页与聊天卡顿未在 1.0.0 复测。

## 安装包更新

macOS 与 Windows 标准安装版支持应用内更新：在「设置 → 通用 → App 更新」检查、下载并核对发布清单的 Ed25519 签名、大小与 SHA-256，再安装并重启。便携版和非标准安装位置需手动更新：退出旧版后运行新安装包。更新不覆盖用户数据，更新前建议导出备份。发布清单的 Ed25519 签名与操作系统代码签名是两种不同的检查。

## 首次设置与模型连接

首次启动可以一次保存快捷设置，也能展开调整个性、主题、玻璃、帧率和画质；模型连接可稍后配置，功能导览可收起或直接开始，不挤压工作区。

API Key 是开放平台调用凭证，不是登录密码或聊天会员；API 费用由供应商按调用量结算。DeepSeek：打开 https://platform.deepseek.com/ → 登录或注册 → 核对 API 账户余额与用量计费 → 在 https://platform.deepseek.com/api_keys 新建密钥 → 复制到引导的密码框 →「保存并测试连接」。不要把密钥发到聊天或截图里。

桌面可在模型设置选择 OpenAI、百炼、硅基流动、智谱预设，或填写 OpenAI 兼容 HTTPS 基础地址和模型 ID；对应密钥单独保存，测试连接后再使用。供应商需支持所选模型的工具或视觉输入。手机云模型仅支持 DeepSeek。本地模型需自行安装并启动。

「ASTaria 推荐」从最高画质开始，首页/聊天目标 60 FPS，持续负载不足时下调并逐步恢复；手动画质保持固定，首页/聊天与相机页面帧率可选 30/45/60/90/120。工作台、余时、日程、设置背景在相机停稳后最高 30 FPS，相机运动期间（含余时与弦轨飞行）沿用所选首页帧率，返回首页恢复选择；画质独立。这个省电上限只影响环境渲染，会降低背景动效更新频率，不限制输入、DOM 或显示器刷新率。

联网搜索默认关闭。桌面版开启后，完整 HTTP/HTTPS 链接由本机抓取公开 HTML，普通关键词发送到 DeepSeek 搜索通道；独立搜索请求不携带课表、聊天或记忆。网页抓取不登录、不执行脚本，拒绝本机和私网地址。

手机端事项、日程、对话与设置保存在应用私有目录，API Key 使用 iOS Keychain 或 Android Keystore 保护，不提供浏览器明文回退；支持 JSON 备份分享与恢复，手机与桌面不会自动同步，手机也不提供目录同步入口。手机云模型仅支持 DeepSeek，不提供本地 Ollama / LM Studio 连接。

可选 4K 背景视频不属于安装包内容，也尚未开放下载；安装后可使用内置的 1080p 视频与 4K 静态图。功能边界见[功能说明](docs/FEATURES.md)。

## 跨设备同步（共享文件夹 / Syncthing 现有目录）

入口为「设置 → 数据 → 跨设备同步」，桌面版提供。

- 选择普通共享文件夹，或已由 Syncthing 共享的目录（须有 `.stfolder` 标记）。新建组使用新目录；原设备把恢复密钥导出到共享目录外，新设备加入并输入 64 位密钥。
- 每台设备保留自己的 SQLite，目录只传 AES-256-GCM 加密的不可变操作文件；不要复制运行中的 SQLite 及其 `-wal` / `-shm`。
- 暂停停止目录读写，本机变更继续排队；恢复后按 30 秒周期扫描，可手动检查或唤醒时检查。界面保留最近检查时间、待处理原因与最近 20 项事务回执，回执不证明远端送达。
- 不同字段自动合并；同字段冲突、锁定、重叠与 DDL 冲突需核对，删除墓碑阻止旧记录复活。日程数组按字段整体合并，可能需要人工处理。
- 同步任务、分类、课程日程、安排、目标和完成记录；历史备份上限为 32 MiB 的 UTF-8 JSON 备份边界。
- API Key、模型路径、聊天及图片、记忆、思考、原始对话回执和跨设备撤销不同步。
- 退出组保留本机与共享文件。撤销设备需使用新目录、新密钥和新组；旧设备已有内容不能远程抹除。全部可信设备与恢复副本丢失密钥时，旧密文不能恢复。
- ASTaria 不安装或配置 Syncthing，不修改防火墙和配对。真实 Syncthing 跨机传送与后续目录优化未验收。
- 单操作明文上限 16 MB，单轮最多 20,000 文件；不压缩操作日志，长期多设备大数据未验收。

## 数据与备份

桌面数据保存在本机 SQLite：macOS 为 `~/Library/Application Support/ASTaria/`，Windows 为 `%APPDATA%\ASTaria`。设置的数据页可导出 JSON 备份并在确认后恢复；备份包含聊天和附件，不包含 API Key 或同步密钥，当前总容量上限 32 MiB。恢复会使旧方案与旧操作快照失效。同步不复制聊天、图片、记忆、思考、本地模型路径或运行中的数据库。请妥善保护备份及另存的同步恢复密钥。

安装包不包含开发者的课表、事项、聊天、记忆、密钥或数据库。通过浏览器运行源码时不提供 DPAPI 与文件夹同步，这两项需要 Electron 桌面包；请避免网页与桌面同时修改同一份数据。

## 历史公开版本 Beta12.1

Beta12.1（`0.1.0-beta.12.1`）仍是当前最新公开版本，可从 [Beta12.1 Release](https://github.com/Wason-dev/ASTaria/releases/tag/v0.1.0-beta.12.1) 下载并核对随包 SHA-256：

- macOS 13+ Apple Silicon：`ASTaria-0.1.0-beta.12.1-mac-arm64-adhoc.dmg`，ad-hoc 签名、未经 Apple 公证。
- Windows x64：`ASTaria-0.1.0-beta.12.1-win-x64-setup.exe` 与 `ASTaria-0.1.0-beta.12.1-win-x64-portable.zip`，未代码签名；Windows 实机安装、体验与升级回退未完成验证。
- Beta12.1 每条消息支持一张 2 MB 的 PNG、JPEG 或 WebP 图片。

Beta12.1 的功能范围、回归检查与验收限制见 [Beta12.1 发布说明](docs/RELEASE_NOTES_v0.1.0-beta.12.1.md)。

## 反馈

请在 [Issues](https://github.com/Wason-dev/ASTaria/issues) 说明版本、系统与复现步骤；附日志前先移除聊天、课表、API Key 等个人信息。安全问题请按 [SECURITY.md](SECURITY.md) 私下报告。
