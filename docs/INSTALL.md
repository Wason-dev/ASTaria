# macOS beta 安装

```text
ASTaria 0.1.0-beta.2 · 小范围内测

系统要求：macOS 13 或更新版本，Apple Silicon（M 系列芯片）。不支持 Intel Mac。
此包采用 ad-hoc 签名，未经 Apple 公证；不是正式公开发行版。

安装
1. 退出正在运行的旧版 ASTaria。
2. 打开 DMG，把 ASTaria.app 拖到旁边的 Applications（应用程序）。
3. 从「应用程序」打开 ASTaria，安装完成后可以推出磁盘映像。

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
