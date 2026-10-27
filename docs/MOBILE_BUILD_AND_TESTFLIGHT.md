# ASTaria 原生构建与 TestFlight 指南

本文件面向构建维护者，说明工具链要求、固定依赖、构建命令和分发流程。本文只给出可复用的流程与验收边界，不记录单次构建结果、机器配置或账号状态。

## 构建要求

- Bundle ID / Android applicationId：`dev.wason.ASTaria`，App Store Connect 的应用记录须使用相同 ID。
- iOS：完整 Xcode、目标 SDK 和模拟器运行时；真机调试与分发还需要对应签名配置。SPM 依赖按工程 `Package.resolved` 固定。
- Android：JDK 21、Android SDK 36；使用工程声明的 Gradle / AGP 和可用的 Build Tools。
- Capacitor：四个平台依赖按 `package-lock.json` 固定为 8.5.3；不在构建时临时升级。
- 手机 marketing version、iOS build number 与 Android versionCode 从原生工程读取，上传时核对并递增各自构建号，不强制等于桌面版本。

## 只读 doctor

在项目根目录运行：

```sh
node scripts/mobile-doctor.mjs --json
node --test scripts/mobile-doctor.test.mjs
```

doctor 始终输出 JSON，字段包括 `schemaVersion`、`scope`、总 `status`、两平台 `platforms`、逐项 `checks` 和 `verification`。每个 check 都有稳定 `id`、`area`、`status: "ready" | "blocked"`、`details`、`remediation`。退出码 `0` 表示所检查前置条件就绪，`1` 表示至少一项 blocked，`2` 表示参数无效。Android 前置条件不依赖 iOS 工具就绪，可单独查看 `platforms.android`。

可指定已配置的工具链路径，路径含空格时必须加引号：

```sh
node scripts/mobile-doctor.mjs --json \
  --android-sdk "/path/to/android-sdk" \
  --java-home "/path/to/jdk21/Contents/Home"
```

将示例路径替换为实际工具链位置，避免默认 PATH 中的其他 JDK 干扰。需要指定 Xcode 时可加 `--xcode-developer-dir "/Applications/Xcode.app/Contents/Developer"`。doctor不替换机器上的默认工具选择。

也可使用任务专用环境变量 `ASTARIA_MOBILE_XCODE_DEVELOPER_DIR`、`ASTARIA_MOBILE_ANDROID_SDK_ROOT`、`ASTARIA_MOBILE_JAVA_HOME`。优先级为显式参数、任务专用变量、系统 `DEVELOPER_DIR` / `ANDROID_SDK_ROOT` / `ANDROID_HOME` / `JAVA_HOME`，最后查 PATH（Xcode 通过 `xcode-select -p`，SDK 可从 PATH 的 `platform-tools/adb` 推导）。不扫描用户目录或读取 `local.properties`；仅放在默认安装位置而没有明确路径的 SDK 不会自动被认定就绪。

doctor 读取固定的公开工程配置和依赖元数据，并只探测 `xcode-select -p`、完整 Xcode 的 `xcodebuild -version`、`xcrun --no-cache --find simctl`、`java -version`、`javac -version`。它不执行配置 TS，不启动 shell，不调用 Gradle、Capacitor sync、SDK 安装器或 adb，不列举模拟器，不访问网络、钥匙串、签名身份、账户、用户资料或已保存 API Key。Java 选项和凭据环境变量不会传给探测进程，原始进程错误不写入 JSON。

SDK 检查仅列出指定 SDK 的 `build-tools` 版本目录并检查平台 jar / 工具文件。工程显式设置 `buildToolsVersion` 时按该值验收；没有显式设置时，优先检查完整的 AGP 默认 `35.0.0`，否则检查已安装且不低于最低值的完整版本（例如 `36.0.0`）。JSON 报告 `buildToolsVersion`、`buildToolsSource`、`availableBuildToolsVersions`，并始终保留 `gradleBuildToolsSelectionVerified=false`。这些字段表示文件可用性；真实 Gradle 是否使用该版本、缓存是否完整、是否尝试下载其他版本，只能由实际执行结果确认。doctor 不修改工程 Build Tools 版本。

静态验收包含：

- 四个 Capacitor 包的精确声明、package lock 根声明、解析版本、integrity 字段和已安装版本一致；这不等于重新验证依赖文件的密码学完整性。
- 手机端版本、正整数 build code、iOS Debug/Release 一致以及 Info.plist 对版本变量的引用。
- appId / Bundle ID / Android applicationId / namespace 一致。
- 保留 `dist-mobile`、本地原生路径、无 `server.url`、HTTPS scheme 和 `allowMixedContent=false`；无法静态解析的动态配置按 blocked 处理。
- iOS 固定 service、ThisDeviceOnly、非同步 Keychain；Android 备份关闭、Keystore AES-256-GCM 与私有 `noBackupFilesDir` 密文记录。
- 项目 SPM lock 中 Capacitor 的版本与 npm lock 一致并有固定 revision；既有 Android 构建版本与生成文件存在。

秘密库检查属于源码契约检查，不能证明真机上的加密、设备锁定、删除、备份恢复或公开导出结果。工程不保留默认的 `ExampleUnitTest` / `ExampleInstrumentedTest`：其 `2+2` 与错误默认包名断言不能验证 ASTaria 插件。当前纯契约测试是 `mobile/runtime/secrets.test.mjs`；尚没有可据此宣称通过的 Android 真机测试。

## 固定构建输入

1. 使用同一源码 revision 和经过 review 的工作树。保留 ASTariaSecrets 的 Swift/Java 插件、iOS ViewController/SceneDelegate/storyboard 注册、Android MainActivity 注册及备份开关。
2. 根据现有 `package-lock.json` 恢复依赖，不用浮动版本、不临时升级 Capacitor、Gradle 或 AGP。Node 至少满足本地 Capacitor CLI 的 `>=22` 要求。依赖恢复、SDK/Xcode 配置均由对应负责人独立处理，构建依赖使用指定的本地工具缓存。
3. 原生依赖负责人在工具链就绪后生成、review 并保存 SPM `Package.resolved`。确认 `capacitor-swift-pm` 解析为 npm lock 的 `8.5.3`，并保留 revision；检查全部插件的解析 pin。仅有 `Package.swift` 的 `from:` 范围不能防止后续解析到不同版本。不要手工伪造 revision 或用最新版解析结果代替已核对 lock。
4. 记录构建使用的 Xcode 版本、JDK 完整版本与路径、SDK 36 路径、Gradle 实际使用的 Build Tools 版本、Gradle/AGP 版本、源码 revision、mobile version/build number 和构建命令。SDK 中已有 `35.0.0` / `36.0.0` 不等于 Gradle 实际选择已验证；实际构建负责人应记录最终选择，不能只抄 doctor 的候选版本。确定性在此指输入可核对、依赖解析受控；不承诺签名包或归档逐字节一致。
5. Android Maven/Gradle 缓存也影响离线构建；doctor 不解析这些依赖或检查整个缓存。首次准备依赖需要单独操作，之后的离线构建遇到缺项应明确失败。

## 后续构建操作模板

以下命令是 payload sync 与原生重建的操作模板。每次变更源码后都须重新同步和构建，工具链可用性以当前 doctor 结果为准。`build:mobile` 仅生成 Web 资源，不能替代 native build。`cap sync` 会更新原生生成文件，需核对 diff；它可能触发依赖解析。

```sh
npm run build:mobile
./node_modules/.bin/cap sync ios
./node_modules/.bin/cap sync android
node scripts/mobile-doctor.mjs --json
```

sync 后再次核对本地插件注册和 secrets 契约，不把 `server.url`、HTTP scheme 或混合内容作为构建修复。`dist-mobile` 与两个原生工程中的 Web 资源必须来自同一次 Web 构建；doctor 不声称已比对它们的内容哈希。

准备并保存解析 lock、所需包缓存后，可以进行不签名的 iOS 模拟器编译：

```sh
DEVELOPER_DIR="/Applications/Xcode.app/Contents/Developer" xcodebuild \
  -project mobile/ios/App/App.xcodeproj \
  -scheme App -configuration Debug \
  -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath "$PWD/.mobile-build/DerivedData-Simulator" \
  -disableAutomaticPackageResolution -onlyUsePackageVersionsFromResolvedFile \
  CODE_SIGNING_ALLOWED=NO build
```

这个命令需要完整 Xcode、现有 simulator SDK 和已准备的 SPM 缓存。没有完整工具链时应报告 blocked，不能将 Swift 语法解析或 plist/XML 检查当作成功执行此命令。

Android debug 构建使用已配置的私有 JDK、SDK 与私有 `GRADLE_USER_HOME`。下方是使用构建专用缓存的离线模板；首次准备依赖时不带 `--offline`，依赖就绪后按此离线重建：

```sh
ASTARIA_BUILD_JAVA_HOME="/path/to/jdk21/Contents/Home"
ASTARIA_BUILD_ANDROID_SDK="/path/to/android-sdk"
ASTARIA_BUILD_GRADLE_USER_HOME="/path/to/gradle-cache"
cd mobile/android
JAVA_HOME="$ASTARIA_BUILD_JAVA_HOME" \
ANDROID_HOME="$ASTARIA_BUILD_ANDROID_SDK" \
ANDROID_SDK_ROOT="$ASTARIA_BUILD_ANDROID_SDK" \
GRADLE_USER_HOME="$ASTARIA_BUILD_GRADLE_USER_HOME" \
PATH="$ASTARIA_BUILD_JAVA_HOME/bin:$PATH" \
  ./gradlew --offline --no-daemon :app:assembleDebug :app:testDebugUnitTest :app:lintDebug
```

`--offline` 要求已有 wrapper 发行包和依赖缓存；缺失时应失败，不为了让命令变绿而允许临时自动下载。SDK / JDK 前置检查就绪不能替代这次执行；保存真实退出码、具体 Gradle task 结果、实际 Build Tools 选择以及输出 APK 的路径和哈希，失败则记录失败原因。后续验收以相应构建的实际报告为准。debug APK 适合本地测试，使用 debug signing；它不是 release 分发包，也没有证明 Keystore 真机路径已经验证。

每次同步 Web 资源后运行负载一致性检查：

```sh
npm run verify:mobile-payload
```

打包 APK 后可追加 APK 检查：

```sh
node scripts/verify-mobile-payload.mjs --apk mobile/android/app/build/outputs/apk/debug/app-debug.apk
```

该检查只读构建输出、原生工程 Web 资源与 APK，检查缺失、变化及旧哈希残留；不能证明原生插件或设备性能。

## TestFlight 账户与签名准备

TestFlight 需要有效的 Apple Developer Program 会员与团队配置。免费 Personal Team 的本地调试不能用于 TestFlight 分发。启用会员后，由签名负责人在 Xcode 和 App Store Connect 中选择/确认对应 Team，完成必要协议、角色权限及账户条件。本项目和 doctor 不保存 Apple 登录凭据、不读取签名钥匙串、不代替账户配置。

| 名称 | 用途与区别 |
| --- | --- |
| Apple Account / Apple ID | 登录和管理账户，不是签名证书 |
| Apple Development | iOS 等设备开发调试签名；不能代替 App Store Connect 分发签名 |
| Apple Distribution | 当前用于 App Store Connect / TestFlight 的分发证书类型；`iOS Distribution` 是历史相关名称，不是 Developer ID Application |
| Developer ID Application | macOS 在 Mac App Store 之外分发、配合 notarization 使用；不用于 iOS TestFlight |
| Provisioning profile | 连接正确 Team、App ID、能力与签名条件；与证书是不同对象，必须与归档/导出用途匹配 |

在开发者账户中注册显式 App ID `dev.wason.ASTaria`。在 App Store Connect 新建 iOS 应用记录，选择完全相同的 Bundle ID，填入名称、主语言、SKU 等信息，核对团队角色。不要因为桌面包名或其他平台工程而改成默认 Capacitor ID。首次上传前签名负责人准备正确分发证书/profile 或在 Xcode 的自动签名流程中配置它们；证书有效性须在实际归档前检查。

每个新的上传构建使用尚未使用、递增的 iOS build number。下面的 `2` 只是示例，使用前须核对工程与 App Store Connect 中已接受的最高构建号。重做二进制后不要复用已上传的 build number。保持 marketing version `1.0`；iOS build number 和 Android versionCode 可各自递增，不强制修改桌面 `package.json` 版本。

## Archive 与本地 export

归档前确认 Xcode 工程的 Scheme 为 `App`、Release 配置、正确 Team、iOS 分发能力和签名条件；Apple Silicon/macOS 本机可用的 Xcode 版本仍须符合当次 App Store Connect 接收要求。先 resolve 并 review SPM lock，再通过以下模板固定解析结果。没有缓存、证书/profile 或会员条件时保留失败，不伪报归档成功。

```sh
ASTARIA_ARCHIVE_PATH="$PWD/.mobile-build/ASTaria.xcarchive"
ASTARIA_IOS_BUILD_NUMBER="2"
ASTARIA_APPLE_TEAM_ID="YOUR_TEAM_ID"
DEVELOPER_DIR="/Applications/Xcode.app/Contents/Developer" xcodebuild \
  -project mobile/ios/App/App.xcodeproj \
  -scheme App -configuration Release \
  -destination 'generic/platform=iOS' \
  -archivePath "$ASTARIA_ARCHIVE_PATH" \
  -derivedDataPath "$PWD/.mobile-build/DerivedData-Archive" \
  -disableAutomaticPackageResolution -onlyUsePackageVersionsFromResolvedFile \
  DEVELOPMENT_TEAM="$ASTARIA_APPLE_TEAM_ID" \
  CURRENT_PROJECT_VERSION="$ASTARIA_IOS_BUILD_NUMBER" archive
```

`YOUR_TEAM_ID` 必须由签名负责人替换，不是有效凭据或当前 Team 声明。命令没有 `-allowProvisioningUpdates`；需要在线创建/更新 profile 时由用户在独立签名步骤处理。命令行版本 override 不修改工程源文件；实际归档版本与构建号应记入该次构建记录。当前工程的静态 doctor 仍按源码版本检查，不能据此推断归档内最终版本。

可先导出本地 IPA，以便检查归档输出，而不上传。准备 `.mobile-build/ExportOptions.plist`（下列为模板，Team ID 要替换）：

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>method</key><string>app-store-connect</string>
  <key>destination</key><string>export</string>
  <key>teamID</key><string>YOUR_TEAM_ID</string>
  <key>signingStyle</key><string>automatic</string>
</dict></plist>
```

```sh
DEVELOPER_DIR="/Applications/Xcode.app/Contents/Developer" xcodebuild \
  -exportArchive -archivePath "$ASTARIA_ARCHIVE_PATH" \
  -exportOptionsPlist "$PWD/.mobile-build/ExportOptions.plist" \
  -exportPath "$PWD/.mobile-build/export"
```

export 的签名要求仍然存在；`destination=export` 表示本地导出，不是 upload。核对归档/IPA 的 Bundle ID、version、build number、签名 Team、嵌入 profile、资源和 secrets 插件注册，再做真机验证。仅运行构建命令不会自动上传。

## App Store Connect 待填写 / 待确认

1. **隐私标签**：按最终行为核对哪些数据只留在设备、哪些会因用户 AI 请求发送给用户选择的供应商。逐项确认聊天内容、附件/照片、日程、标识符、诊断等是否被开发者或第三方收集、用途、是否关联身份、是否用于追踪。供应商的数据保留与用途需要实际确认；不能仅因数据库在本地就勾选“无数据收集”。提供真实可访问的隐私政策 URL 和相应说明。
2. **隐私资源与权限**：核对最终插件涉及的权限说明、required-reason API 与第三方 SDK 隐私清单。API Key 使用 Keychain 本身不代表所有插件的隐私清单和权限已审完。不要顺便加入与实现无关的权限、manifest 或声明。
3. **出口合规**：按最终 App/SDK 的加密实现回答 App Store Connect 问项：是否使用加密（含 HTTPS、Keychain、Keystore/AES-GCM 等实际用途），是否只使用标准/系统加密，是否有自研或非豁免算法，适用哪些地区/分发方式，是否需要相关备案、文件或年度报告。由责任人按 Apple 与适用主管机关规则确认豁免或申报义务。**不得自行断言免申报，也不自动设置 `ITSAppUsesNonExemptEncryption=false`。**
4. **TestFlight 信息**：填写真实的测试说明、反馈联系信息、审核联系信息、必要的测试账号/操作步骤。API Key 不应写入说明、截图、日志或资料备份；需要外部服务时明确说明测试者如何使用自己的配置。
5. **测试范围**：先确认内部测试人员还是外部测试人员。外部测试及公开邀请链接可能涉及 Beta App Review 和额外表单；内部测试、公开邀请与正式上架应分别决定。测试构建有有效期，之后仍需新构建。

账户、隐私和合规信息完成后，用户可在 Xcode Organizer 中按 App Store Connect 的分发/上传流程，或使用已配置的 Transporter 上传经核验 IPA。上传与本地归档是两个独立步骤；只有取得发布授权后才上传。

## 真机验收与 Android 后续 release

在测试专用环境使用合成测试 token，验证保存、读取、覆盖、删除、重启、设备锁定/恢复与损坏记录的明确失败语义。确认日志没有 token，Web preview 的 read/write/remove 明确不支持，公开导出/备份/分享文件没有秘密；验证 iOS ThisDeviceOnly 的设备绑定及 Android noBackupFilesDir 的备份/恢复行为。ThisDeviceOnly 的源码属性不能代替系统备份的真机验证。Android 删除要验证 Keystore alias 与密文记录都清理；缺失或损坏密钥不能被当作未配置。

Android debug keystore 仅用于开发测试。未来 release 必须单独确定 app signing / upload key 策略；如采用 Google Play App Signing，app signing key 与 upload key 的职责也不同。既有同包名更新依赖签名连续性，不能随意换 key。妥善保管 release keystore、私钥、alias、密码和恢复资料：不可丢失，不进入 Git、应用资源、公开资料备份、日志或代理任务；应用内 API Key 的备份排除与发布签名材料的受控保管是两类要求。debug 构建使用 Gradle 的标准 debug signing，不能作为正式分发签名。

## 官方资料（实际操作前核对当前要求）

- [Capacitor 8 环境准备](https://capacitorjs.com/docs/getting-started/environment-setup)
- [Apple Developer Program](https://developer.apple.com/programs/)
- [TestFlight 概览](https://developer.apple.com/testflight/)
- [App Store Connect：添加应用](https://developer.apple.com/help/app-store-connect/create-an-app-record/add-a-new-app/)
- [App Store Connect：上传构建](https://developer.apple.com/help/app-store-connect/manage-builds/upload-builds/)
- [Apple 签名证书](https://developer.apple.com/help/account/certificates/certificates-overview/)
- [App 隐私信息](https://developer.apple.com/app-store/app-privacy-details/)
- [出口合规概览](https://developer.apple.com/help/app-store-connect/manage-app-information/overview-of-export-compliance/)
- [Gradle Java 兼容表](https://docs.gradle.org/current/userguide/compatibility.html)
- [Android Gradle Plugin 8.13](https://developer.android.com/build/releases/past-releases/agp-8-13-0-release-notes)
- [Android 应用签名](https://developer.android.com/studio/publish/app-signing)
- [Android 备份行为](https://developer.android.com/identity/data/autobackup)

以上链接供实际操作前人工核对；doctor 与本文档的维护过程不联网访问账户或下载工具链。
