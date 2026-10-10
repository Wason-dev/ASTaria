# ASTaria Beta12 预发布包安装

技术版本 `0.1.0-beta.12`（展示名称 **Beta12**）：macOS 13+ Apple Silicon（arm64）使用 ad-hoc 签名包，未经 Apple 公证；Windows x64 提供未签名试验包。从 [Beta12 Release](https://github.com/Wason-dev/ASTaria/releases/tag/v0.1.0-beta.12) 下载，核对随包 SHA-256。发布清单、源码提交与验收证据见 [Beta12 说明](https://github.com/Wason-dev/ASTaria/blob/main/docs/RELEASE_NOTES_v0.1.0-beta.12.md)。

Windows 仍有卡顿反馈；当前包实机安装与交互、Windows 11、真实自动升级/失败回退未验收。CI 与包内容检查不等于真实电脑体验通过。

## macOS 13+ · Apple Silicon

```text
ASTaria 0.1.0-beta.12 · Beta12 预发布包

系统要求：macOS 13 或更新版本，Apple Silicon（M 系列芯片）。不支持 Intel Mac。
此包采用 ad-hoc 签名，未经 Apple 公证。

安装
1. 退出正在运行的旧版 ASTaria。
2. 打开 ASTaria-0.1.0-beta.12-mac-arm64-adhoc.dmg。
   根目录只有 ASTaria.app、指向 /Applications 的 Applications 快捷方式和安装说明。
   把 ASTaria.app 拖到 Applications 快捷方式上；首次安装由用户完成拖拽。
3. 从「应用程序」打开 ASTaria，安装后可推出磁盘映像。

检查与安装更新
「设置 → 通用 → App 更新」可查看版本、检查 GitHub 发布并下载 DMG。
默认自动检查，App 可见时最多每六小时一次，也可手动检查或关闭。
Beta 用户能收到后续 beta 和正式版；正式版用户只收到正式发布。
同版本的新构建依据 App 构建时间及源码提交识别，不依据发布说明编辑时间。
点击「下载并校验」，完成后选择「安装并重启」。安装前校验大小、SHA-256、
App 身份与签名，并验证发布清单的 Ed25519 签名；启动未成功时会尝试回退。
App 必须位于可写目录，不能直接在 DMG 内更新。
更新不覆盖 Application Support 中的本机数据，更新前建议导出备份。
若检查失败，可访问 https://github.com/Wason-dev/ASTaria/releases 。

系统提醒
在「设置 → 通知」开启「关闭 App 后仍提醒」，按系统提示允许 ASTaria 提醒。
预约交给 macOS，无需 App 常驻；覆盖未来 30 天内最近的 64 条，打开或恢复时补充。
Beta12 修改安排时间后会取消旧预约并按新时刻重建；完成或删除也会取消。
免打扰、系统专注模式和关机会影响送达，原生送达仍需设备验证。

如果打不开
先正常尝试打开一次。如果提示无法验证开发者，到「系统设置 → 隐私与安全性」
找到 ASTaria，选择「仍要打开」并按系统提示确认。

若仍被下载隔离标记拦截，确认包来自可信来源且已移到 /Applications 后，
在「终端」运行：

/usr/bin/codesign --verify --deep --strict --verbose=2 "/Applications/ASTaria.app" && \
/usr/bin/xattr -dr com.apple.quarantine "/Applications/ASTaria.app" && \
/usr/bin/open "/Applications/ASTaria.app"

第一行检查 App 签名完整性，失败时不会继续执行；ad-hoc 签名不证明发布者身份。
第二行只移除此 App 的隔离标记，不关闭全系统安全设置；第三行启动 App。
无需 sudo，不要重新签名或关闭 Gatekeeper。上述命令不修复崩溃、芯片不兼容或文件损坏。

安装包不含开发者的课表、事项、聊天、记忆、密钥或数据库。首次使用需自行设置模型，
录入课程和安排。此版本沿用已有 ASTaria 本机数据，请避免网页和桌面同时修改同一份数据。
```

## Windows x64（Beta12 试验包）

Release 提供 `ASTaria-0.1.0-beta.12-win-x64-setup.exe`（NSIS 当前用户安装程序）及
`ASTaria-0.1.0-beta.12-win-x64-portable.zip`，不单独分发缺少运行时的 EXE。未做代码签名，
不承诺 Windows 11 体验；Windows 10 历史测试不能代替本版成品验收。

```text
ASTaria 0.1.0-beta.12 · Beta12 试验包 · Windows x64

1. setup.exe：双击运行，按提示安装后从开始菜单或安装目录启动，无需管理员权限。
   portable.zip：完整解压到新目录，再运行其中的 ASTaria.exe，不要只移动单个 EXE。
2. 安装目录为 %LOCALAPPDATA%\Programs\ASTaria；数据目录为 %APPDATA%\ASTaria。
   安装与便携共用当前用户数据，卸载保留用户数据。
3. 标准安装版从 Beta11 起可在「设置 → 通用 → App 更新」检查、下载并校验
   Ed25519 发布清单签名、SHA-256 和大小，然后退出 App、静默安装并重启。
   自动检查默认开启，App 可见时最多每六小时一次，可手动检查或关闭。
   新版本启动确认失败时尝试回退；回退失败需人工恢复。更新不覆盖用户数据。
4. portable.zip 与其它安装位置需手动更新；退出旧版后完整解压新包或运行新 setup.exe。
5. BetaX（0.1.0-beta.10）没有 Windows 应用内更新，第一次升级必须手动安装。
6. Windows 真实自动升级与失败回退、当前包实机安装和交互、Windows 11 未验收。
7. Windows 当前仅 App 内提醒摘要与状态，尚未支持系统弹窗和原生预约。
   App 内摘要与状态会随修改后的安排更新。
8. 在浏览器运行源码不提供 DPAPI 和文件夹同步，两项需要 Electron 桌面包。
```

更多 GPU、DPI/多屏、休眠恢复、长期功耗及 Windows 原生通知显示未验收。
`scripts/package-windows.mjs` 使用独立的 Electron win32-x64 运行时、资源编辑器与 NSIS；
缺少 NSIS 时只生成便携 ZIP 和脚本。最终 Release 的 Windows 清单须由仓库外保存的
`wason-2026-01` 配对私钥签名，使用 `scripts/sign-release-manifest.mjs`，私钥不随包分发。
发布清单的 Ed25519 验签与 Windows 代码签名是不同的检查。

## 首次设置、模型与外观

首次启动选择个性、主题、玻璃、帧率和画质，也可跳过 API Key 稍后配置。
「ASTaria 推荐」从最高画质开始，首页/聊天目标 60 FPS，持续负载不足时下调并逐步恢复；
手动画质保持固定，首页/聊天帧率可选 30/45/60/90/120。Beta12 的工作台、余时、日程、
设置背景最高 30 FPS，返回首页恢复选择，画质独立。这个省电上限只影响环境渲染，
会降低背景动效更新频率，不限制输入、DOM 或显示器刷新率。

联网搜索默认关闭。开启后，完整 HTTP/HTTPS 链接由本机抓取公开 HTML，普通关键词发送到
DeepSeek 搜索通道；独立搜索请求不携带课表、聊天或记忆。网页抓取不登录、不执行脚本，
拒绝本机和私网地址。搜索无正文时的固定兜底仍待改进。

聊天可上传一张不超过 2 MB 的 PNG/JPEG/WebP。云端模式会把图片发给当前模型，本地模式
发送到已配置的回环服务；需要视觉模型，实际识图未验收。图片保存在本机和 JSON 备份里，
不进入跨设备同步。备份不含 API Key 或同步密钥，请妥善保护并另存同步恢复密钥。
本地模型运行时需自行安装和启动，真实模型下载、推理、工具和识图未验收。

## 跨设备同步（共享文件夹 / Syncthing 现有目录）

路径为「设置 → 数据 → 跨设备同步」。

- 选择普通共享文件夹，或已由 Syncthing 共享的目录（须有 `.stfolder` 标记）。
  新建组使用新目录；原设备把恢复密钥导出到共享目录外，新设备加入并输入 64 位密钥。
- 每台设备保留自己的 SQLite，目录只传 AES-256-GCM 加密的不可变操作文件。
  不要复制运行中的 SQLite 及其 `-wal` / `-shm`。
- 暂停停止目录读写，本机变更继续排队；恢复后按 30 秒周期扫描，可手动检查或唤醒时检查。
  界面保留最近检查时间、待处理原因与最近 20 项事务回执，回执不证明远端送达。
- 不同字段自动合并；同字段冲突、锁定、重叠与 DDL 冲突需核对，删除墓碑阻止旧记录复活。
  日程数组按字段整体合并，可能需要人工处理。
- 同步任务、分类、课程日程、安排、目标和完成记录。
- API Key、模型路径、聊天及图片、记忆、思考、原始对话回执和跨设备撤销不同步。
- 退出组保留本机与共享文件。撤销设备需使用新目录、新密钥和新组；旧设备已有内容不能远程抹除。
  全部可信设备与恢复副本丢失密钥时，旧密文不能恢复。
- ASTaria 不安装或配置 Syncthing，不修改防火墙和配对。真实 Syncthing 跨机传送与后续目录优化未验收。
- 单操作明文上限 16 MB，单轮最多 20,000 文件；不压缩操作日志，长期多设备大数据未验收。
