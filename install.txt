# ASTaria Beta11 本地测试包安装

本地技术版本 `0.1.0-beta.11`（展示名称 **Beta11**），本轮以本地测试包交付：macOS 13+ Apple Silicon（arm64）的 ad-hoc 签名包，未经 Apple 公证。下面的文件名与步骤对应当前本地 Beta11 交付。

GitHub 上仍没有 Beta11，公开下载的最新版仍是 BetaX · `0.1.0-beta.10`；需要公开版请用 [Releases](https://github.com/Wason-dev/ASTaria/releases)。

## macOS 13+ · Apple Silicon

```text
ASTaria 0.1.0-beta.11 · Beta11 本地测试包

系统要求：macOS 13 或更新版本，Apple Silicon（M 系列芯片）。不支持 Intel Mac。
此包采用 ad-hoc 签名，未经 Apple 公证；不是正式公开发行版。

安装
1. 退出正在运行的旧版 ASTaria。
2. 打开 DMG（ASTaria-0.1.0-beta.11-mac-arm64-adhoc.dmg）。DMG 根目录只有 ASTaria.app、
   指向 /Applications 的 Applications 快捷方式和这份安装说明；把 ASTaria.app 拖到
   Applications 快捷方式上。DMG 打包脚本不会替你复制进 /Applications，首次手动安装由你完成拖拽。
3. 从「应用程序」打开 ASTaria，安装完成后可以推出磁盘映像。

说明：也可以在「设置 → 通用 → App 更新」中检查更新。

检查与安装更新
「设置 → 通用 → App 更新」可查看版本、检查 GitHub 发布并下载 DMG。
默认自动检查，App 可见时最多每六小时一次，也可手动检查或关闭自动检查。
Beta 用户能收到后续 beta 和正式版；正式版用户只收到正式发布。
同版本的新构建也可识别，依据 App 构建时间及源码提交，不依据发布说明的编辑时间。
点击「下载并校验」，完成后选择「安装并重启」。安装前校验大小、SHA-256、App 身份与签名，
并验证发布清单的 Ed25519 签名；新版本启动未成功时会尝试回退。
App 须位于可写目录，不能直接在 DMG 内更新。
安装包不会覆盖 Application Support 中的本机数据，建议更新前在「设置 → 数据」导出备份。
联网搜索是独立的可选通道，默认关闭。打开前请确认你接受查询词发送到 DeepSeek 云端；本地模型正文仍由本机服务处理。它使用现有 DeepSeek API Key 和官方 Anthropic 搜索端点，不会把课表、事项、聊天或记忆拼入搜索请求。
若检查暂时失败，可直接访问 https://github.com/Wason-dev/ASTaria/releases 。

系统提醒
在「设置 → 通知」开启「关闭 App 后仍提醒」，按系统提示允许 ASTaria 提醒。
预约交给 macOS，不需要 App 常驻；最多覆盖未来 30 天内最近的 64 条，打开或恢复 App
会继续补充。已完成或移除的安排会取消预约。免打扰、系统专注模式和关机会影响送达。

如果打不开
先正常尝试打开一次。如果 macOS 提示无法验证开发者，可到「系统设置 → 隐私与安全性」
找到 ASTaria 并选择「仍要打开」，按系统提示确认。

若仍被下载隔离标记拦截，确认这份内测包来自可信来源且已移到 /Applications 后，
在「终端」粘贴以下三行：

/usr/bin/codesign --verify --deep --strict --verbose=2 "/Applications/ASTaria.app" && \
/usr/bin/xattr -dr com.apple.quarantine "/Applications/ASTaria.app" && \
/usr/bin/open "/Applications/ASTaria.app"

第一行检查 App 签名完整性；检查失败时后两行不会执行。ad-hoc 签名不证明发布者身份，
来源请向发包者确认，DMG 的 SHA-256 可用随包校验文件核对。
第二行仅移除此 App 的下载隔离标记，不关闭全系统安全设置。第三行启动 App。
无需 sudo；不要重新签名或关闭 Gatekeeper。这组命令只处理系统隔离拦截，不修复崩溃、
芯片不兼容或文件损坏。如有错误，请把终端错误和系统提示发给提供内测包的人。

安装包不含开发者的课表、事项、聊天记录、记忆或数据库。新用户只会看到通用分类和
可自行调整、确认的默认可用时段，需要录入自己的课程与安排。

测试前请从「设置 → 数据」导出备份。此版本沿用这台 Mac 上已有的 ASTaria 本机数据；
请避免网页和桌面版同时修改同一份数据。首次使用需在设置里配置自己的模型连接。
```

## Windows 10/11 · x64（Beta11 本地测试包）

本地 Beta11 交付包含两个 Windows x64 资产：`ASTaria-0.1.0-beta.11-win-x64-setup.exe`（NSIS
安装程序，默认装到当前用户目录，不需要管理员权限）与 `ASTaria-0.1.0-beta.11-win-x64-portable.zip`。
两者都是本地测试包，不是正式 Windows 发行版，也不承诺 Windows 11。

Windows 10 x64（19044）已用于本轮原生交互测试，涵盖 Electron、React、本机 API、SQLite、
WebGL2 和 DPAPI 凭据保护。最终包的安装与运行结果以 [Beta11 说明](RELEASE_NOTES_v0.1.0-beta.11.md)
为准；不把历史版本的 123 项测试记录当成本版结果。

未验收：Windows 11、原地升级、睡眠恢复、更多 DPI/多屏配置（目前仅覆盖 DPR 1.5）、长期功耗
与 Windows 原生通知。更新前请导出备份并退出旧版。

```text
ASTaria 0.1.0-beta.11 · Beta11 本地测试包 · Windows x64

1. setup.exe：双击运行，按提示完成后从开始菜单或安装目录启动 ASTaria。
   portable.zip：解压整个 ZIP，不要只移动单个 EXE，运行解压目录里的 ASTaria.exe。
2. 数据保存在 %APPDATA%\ASTaria，不随 EXE 移动，安装与便携两种方式共用这份数据。
   安装写入 %LOCALAPPDATA%\Programs\ASTaria；卸载保留用户数据。
3. 更新：先导出备份、退出 App，再运行新版本的 setup.exe，或把新包解压到新目录后再启动。
4. 没有 Windows 自动更新，也没有退出 App 后的提醒。
5. 在浏览器里运行源码不提供 DPAPI 和文件夹同步；这两项需要运行 Electron 包。
```

打包脚本 `scripts/package-windows.mjs` 需要自行准备解压好的 Electron win32-x64 运行时；NSIS
安装程序需要额外提供 `makensis` 才会编译，Release 上的 `setup.exe` 由这一步产出，未提供时
只产出便携 ZIP 和 `.nsi`。不要共享或直接复制运行中的 SQLite 及其 `-wal` / `-shm` 文件。

## 跨设备同步（共享文件夹 / Syncthing 现有目录）

设置路径为「设置 → 数据 → 跨设备同步」。

- 选择普通共享文件夹，或选择用户已经用 Syncthing 共享的本地目录；Syncthing 目录需要
  `.stfolder` 标记才会被识别。新建组选择新目录；原设备把恢复密钥导出到共享目录之外，
  新设备选择加入并输入 64 位密钥。
- 每台设备保留自己的 SQLite，所选目录只传 AES-256-GCM 加密的不可变操作文件。
- 暂停停止目录读写，本机变更继续排队；恢复后按 30 秒周期扫描，也支持手动检查，并在系统唤醒时检查。
  最近检查时间会持久化，界面显示待处理原因和最近 20 项事务回执。
- 回执只表示本机已记录事务，不是远端送达证明。
- 不同字段的改动自动合并；同字段冲突可选择保留本机或重新核验传入内容。
- 删除 tombstone 不会复活旧记录；锁定、时间重叠和 DDL 冲突进入待处理，需人工确认。
  日程仍按整文档内的数组级合并，可能需要人工处理。
- 同步内容：任务、分类、课程日程、安排、目标与完成记录。
- 不同步：API Key、模型路径、聊天、记忆、思考、原始对话回执与跨设备撤销。只有业务事务摘要回执。
- 退出组保留本机数据和共享文件；撤销设备必须使用新目录、新密钥和新组，全部可信设备和恢复副本都丢失密钥时，旧密文无法恢复。
- 传输软件由用户自备：ASTaria 不安装、不配置 Syncthing，也不修改防火墙或配对设置。
  Syncthing 实际跨机传送尚未验收，目前只验证了目录协议与标记。
- 限制与未验收：单次操作 16 MB，单轮 20000 个文件，日志不做压缩；超过限制或多设备大量
  数据未验收。
