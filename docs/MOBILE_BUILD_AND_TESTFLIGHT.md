# ASTaria v1.0 原生构建与 TestFlight 准备

本文件记录可重复的构建输入、只读前置检查、实际执行结果和后续操作模板。当前目标是先进行 iOS TestFlight 测试；之后如何公开发布仍未确定。Apple 团队与分发签名尚未配置。Android 首轮 debug 编译与 lint 已通过；当前 10/16 本机候选 APK 已重建并同步，iOS Web payload 同步了相同资源（见下方最终批次记录）。仍未进行原生硬件测试；iOS 仍缺完整 Xcode。archive、分发 export 和 upload 均未执行，正式手机验收及发布尚未完成。

## 当前输入与阻塞

| 项目 | 当前输入 / 状态 |
| --- | --- |
| Bundle ID / Android applicationId | `dev.wason.ASTaria`，须与 App Store Connect 中的应用记录一致 |
| 手机端版本 | iOS `MARKETING_VERSION=1.0`；Android `versionName="1.0"` |
| 构建号 | iOS `CURRENT_PROJECT_VERSION=1`；Android `versionCode=1`；本轮不改版本 |
| 桌面包版本 | `package.json` 的桌面版本与手机原生版本是不同发布轨道，不应强制相等 |
| Capacitor | core / cli / ios / android 均精确声明、lock 解析和本地安装为 `8.5.3` |
| iOS 依赖 | SPM 的 `from: "8.0.0"` 是范围；当前缺少提交的 `Package.resolved`，确定性解析 **blocked** |
| Xcode / simctl | 当前只有 CommandLineTools，完整 Xcode 与 simctl **blocked** |
| Android | 既有 Gradle `8.14.3`、Android Gradle Plugin `8.13.0`、compile/target SDK `36`、min SDK `24`；本轮不改这些版本 |
| Android 首轮构建（历史） | `assembleDebug testDebugUnitTest lintDebug --no-daemon` 整体 `BUILD SUCCESSFUL`，耗时 `3m56s`、`324 tasks`；首轮 debug 编译与 lint 通过，此后已按最终资源重建；原生硬件未测试 |
| Android 最新重建（2026-10-16 手机详情批次） | `dist-mobile` 已同步至 Android/iOS；使用专用 JDK 21、Android SDK 和 Gradle 缓存，在线解析缺失依赖后离线执行 `:app:assembleDebug :app:testDebugUnitTest :app:lintDebug`，`BUILD SUCCESSFUL in 17s`、`288 tasks`，App lint 0 错误 15 警告，`testDebugUnitTest` 为 `NO-SOURCE`；本机候选 APK SHA-256 `a9eb111c12aae690ffd57f60c77667bb8a023d68cab516318d3f7c3a3b023546`，**52 项 Web 资源**在 APK、Android/iOS 工程与 `dist-mobile` 逐字节一致，v2 debug 签名及 ZIP CRC 验证通过；未实机。详情与哈希见 `artifacts/package-2026-10-16/` |
| Android 首次使用重建（2026-10-15 早批次，历史） | 同一离线命令当时为 `BUILD SUCCESSFUL in 15s`、`288 tasks`，App lint 0 错误 14 警告，`testDebugUnitTest` 为 `NO-SOURCE`；该批 APK 通过 v2 debug 签名与 29 项当前 Web 资源字节一致检查。**该 APK 已被上述晚批次替换**，29 项为该批历史值 |
| JDK | 私有 JDK 21 已可用；使用下文指定路径时 java / javac 均检测为 21，前置检查 **ready**。默认 PATH 可能仍选择 JDK 25，须显式选择 JDK 21 |
| Android SDK | 私有 SDK 已有 platform 36、platform-tools 和 Build Tools `36.0.0`；最新只读检测也发现完整 `35.0.0`，前置检查 **ready**。既有 AGP 默认/最低值为 `35.0.0`，实际 Gradle 选择尚未由此检查流程验证 |
| TestFlight | 会员、Team、App Store Connect 应用记录和分发签名尚未准备；**upload 未执行** |

只读 doctor 于 2026-10-12 在共享工作树中使用下文私有 SDK / JDK 路径得到：`platforms.android="ready"`、`platforms.ios="blocked"`，总状态为 `blocked`、退出码为 `1`。这是前置检查结果，实际首轮 Gradle 结果单独记录于下文。iOS 的三个阻塞项为完整 Xcode、simctl 和项目 SPM lock。版本与安装状况会随其他工作的进展改变，每次准备构建时重新运行 doctor。`ready` 只表示 doctor 检查的本地前置条件满足，不证明构建、签名、会员资格或上传成功。

## Android 首轮执行记录

2026-10-12，在独立工具链环境运行下列 Gradle 命令，退出码为 0。实际构建结果独立于 doctor 的只读前置检查。

| 项目 | 首轮记录 |
| --- | --- |
| 执行目录 | `mobile/android` |
| `JAVA_HOME` | `/Users/mac/Library/Caches/ASTaria-build-tools/jdk21/jdk-21.0.12.1+1/Contents/Home`，任务专用 JDK 21 |
| `ANDROID_SDK_ROOT` | `/Users/mac/Library/Caches/ASTaria-build-tools/android-sdk`，私有 SDK |
| `GRADLE_USER_HOME` | `/Users/mac/Library/Caches/ASTaria-build-tools/gradle`，构建专用缓存 |
| 实际命令 | `./gradlew assembleDebug testDebugUnitTest lintDebug --no-daemon` |
| 结果 | `BUILD SUCCESSFUL`，`3m56s`，`324 tasks` |
| debug APK | `mobile/android/app/build/outputs/apk/debug/app-debug.apk` |

该结果确认首轮 Android debug 编译与 lint 通过。命令同时请求了 `testDebugUnitTest`；本工程没有可据此证明 ASTaria 原生插件行为的设备测试，编译成功不代表插件真机路径通过。原生硬件、Keystore 在设备上的加解密、备份恢复和完整手机流程仍未测试。

2026-10-12 追加使用同一工具链执行 `./gradlew compileDebugJavaWithJavac testDebugUnitTest lintDebug --offline --no-daemon`，退出码 0，`BUILD SUCCESSFUL in 20s`，289 个 task 中 50 个执行、239 个已是最新。App lint 报告为 0 个错误、21 个警告，包含现有资源、图标与依赖版本提示；`testDebugUnitTest` 为 `NO-SOURCE`，不能将其计为原生行为测试通过。此次仅复核原生编译与 lint，没有执行 APK 打包。这是首轮之后的一次原生复核记录，其 21 个警告为首轮历史值。

## Android 最终重建记录

2026-10-12，当轮最终资源经 `npm run build:mobile` 与 `cap sync` 更新后，使用同一私有工具链离线执行 `./gradlew assembleDebug testDebugUnitTest lintDebug --offline --no-daemon`，实际 `BUILD SUCCESSFUL in 21s`、`324 tasks`。App lint 为 0 个错误、15 个警告（首轮的 21 个警告为历史记录），`testDebugUnitTest` 为 `NO-SOURCE`；当时产出的 debug APK 通过 v2 debug 签名验证，并与该轮 Web 资源逐字节一致核对（24 项）。此为历史构建记录，当前 APK 已由下述 10 月 15 日构建替换。

2026-10-15，手机性能、排版及黑洞右移构图完成后重新执行 `npm run build:mobile`、`cap copy android`、`cap copy ios` 与同一离线 Gradle 命令，`BUILD SUCCESSFUL in 11s`，288 个 task（6 执行、282 已是最新），App lint 0 错误、14 警告，原生单元测试仍为 `NO-SOURCE`。类型检查、桌面/手机生产构建通过，全量源码 2,205 项通过；手机浏览器矩阵 1,790 项通过。iOS 只同步 Web 资源，没有进行 Xcode 编译。

上段的 debug APK（6,190,714 字节，SHA-256：`c4a0c3aa38ebcf38a2603917299a66c2d639bb53cb3464a982cd0682d184ed3f`）是 2026-10-15 手机性能批次的历史值；**该文件已在 2026-10-15 晚批次（2026-10-16 上午替换）被替换**。当时已验证 v2 debug 签名，并检查 29 项 Web 资源在 `dist-mobile`、Android/iOS 工程及 APK 中逐字节一致且没有残留旧资源；原生编译输出 `mobile/android/app/build/outputs/apk/debug/app-debug.apk` 与当时的交付文件相同。没有连接测试手机，没有安装到设备，也没有新增版本目录或公开上传。

每次同步后运行资源验证，`sync:mobile` 已包含不带 APK 的两端验证；打包后追加 APK 检查：

```sh
npm run verify:mobile-payload
node scripts/verify-mobile-payload.mjs --apk mobile/android/app/build/outputs/apk/debug/app-debug.apk
```

该检查只读构建输出、工程 Web 资源与 APK，检查缺失、变化及旧哈希残留；不证明原生插件或设备性能。执行记录与逐文件哈希在本地 `artifacts/mobile-performance-2026-10-15/`。

这次重建只证明该次输入下的 Android debug 编译、lint、签名与资源一致性；它不代表原生设备验收、正式 release 签名或分发，也没有覆盖软键盘、通知送达、分享面板或 GPU 表现。每次 Web 资源或原生输入更新并 sync 后仍须重新执行上述 Gradle tasks，记录当次源码 / payload、工具版本、退出码与 APK 哈希。

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
  --android-sdk "/Users/mac/Library/Caches/ASTaria-build-tools/android-sdk" \
  --java-home "/Users/mac/Library/Caches/ASTaria-build-tools/jdk21/jdk-21.0.12.1+1/Contents/Home"
```

上面使用当前已提供的私有工具链路径，避免默认 PATH 中的其他 JDK 干扰。完整 Xcode 尚未可用；之后配置好完整 Xcode 才添加 `--xcode-developer-dir "/Applications/Xcode.app/Contents/Developer"`。doctor 不替换机器上的默认工具选择。

也可使用任务专用环境变量 `ASTARIA_MOBILE_XCODE_DEVELOPER_DIR`、`ASTARIA_MOBILE_ANDROID_SDK_ROOT`、`ASTARIA_MOBILE_JAVA_HOME`。优先级为显式参数、任务专用变量、系统 `DEVELOPER_DIR` / `ANDROID_SDK_ROOT` / `ANDROID_HOME` / `JAVA_HOME`，最后查 PATH（Xcode 通过 `xcode-select -p`，SDK 可从 PATH 的 `platform-tools/adb` 推导）。不扫描用户目录或读取 `local.properties`；仅放在默认安装位置而没有明确路径的 SDK 不会自动被认定就绪。

doctor 读取固定的公开工程配置和依赖元数据，并只探测 `xcode-select -p`、完整 Xcode 的 `xcodebuild -version`、`xcrun --no-cache --find simctl`、`java -version`、`javac -version`。它不执行配置 TS，不启动 shell，不调用 Gradle、Capacitor sync、SDK 安装器或 adb，不列举模拟器，不访问网络、钥匙串、签名身份、账户、用户资料或已保存 API Key。Java 选项和凭据环境变量不会传给探测进程，原始进程错误不写入 JSON。

SDK 检查仅列出指定 SDK 的 `build-tools` 版本目录并检查平台 jar / 工具文件。工程显式设置 `buildToolsVersion` 时按该值验收；没有显式设置时，优先检查完整的 AGP 默认 `35.0.0`，否则检查已安装且不低于最低值的完整版本（例如 `36.0.0`）。JSON 报告 `buildToolsVersion`、`buildToolsSource`、`availableBuildToolsVersions`，并始终保留 `gradleBuildToolsSelectionVerified=false`。这些字段表示文件可用性；真实 Gradle 是否使用该版本、缓存是否完整、是否尝试下载其他版本，只能由实际执行结果确认。当前检测来源为 `agp-default`，候选版本为 `35.0.0`，同时检测到 `36.0.0`；此检查流程没有设置工程 Build Tools 版本。

静态验收包含：

- 四个 Capacitor 包的精确声明、package lock 根声明、解析版本、integrity 字段和已安装版本一致；这不等于重新验证依赖文件的密码学完整性。
- 手机端版本、正整数 build code、iOS Debug/Release 一致以及 Info.plist 对版本变量的引用。
- appId / Bundle ID / Android applicationId / namespace 一致。
- 保留 `dist-mobile`、本地原生路径、无 `server.url`、HTTPS scheme 和 `allowMixedContent=false`；无法静态解析的动态配置按 blocked 处理。
- iOS 固定 service、ThisDeviceOnly、非同步 Keychain；Android 备份关闭、Keystore AES-256-GCM 与私有 `noBackupFilesDir` 密文记录。
- 项目 SPM lock 中 Capacitor 的版本与 npm lock 一致并有固定 revision；既有 Android 构建版本与生成文件存在。

秘密库检查属于源码契约检查，不能证明真机上的加密、设备锁定、删除、备份恢复或公开导出结果。默认 `ExampleUnitTest` / `ExampleInstrumentedTest` 已删除：它们原有的 `2+2` 和错误默认包名断言不能验证 ASTaria 插件。当前纯契约测试是 `mobile/runtime/secrets.test.mjs`；尚没有可据此宣称通过的 Android 真机测试。

## 固定构建输入

1. 使用同一源码 revision 和经过 review 的工作树。保留 ASTariaSecrets 的 Swift/Java 插件、iOS ViewController/SceneDelegate/storyboard 注册、Android MainActivity 注册及备份开关。
2. 根据现有 `package-lock.json` 恢复依赖，不用浮动版本、不临时升级 Capacitor、Gradle 或 AGP。Node 至少满足本地 Capacitor CLI 的 `>=22` 要求。依赖恢复、SDK/Xcode 配置均由对应负责人独立处理，构建依赖使用指定的本地工具缓存。
3. 原生依赖负责人在工具链就绪后生成、review 并保存 SPM `Package.resolved`。确认 `capacitor-swift-pm` 解析为 npm lock 的 `8.5.3`，并保留 revision；检查全部插件的解析 pin。仅有 `Package.swift` 的 `from:` 范围不能防止后续解析到不同版本。不要手工伪造 revision 或用最新版解析结果代替已核对 lock。
4. 记录构建使用的 Xcode 版本、JDK 完整版本与路径、SDK 36 路径、Gradle 实际使用的 Build Tools 版本、Gradle/AGP 版本、源码 revision、mobile version/build number 和构建命令。SDK 中已有 `35.0.0` / `36.0.0` 不等于 Gradle 实际选择已验证；实际构建负责人应记录最终选择，不能只抄 doctor 的候选版本。确定性在此指输入可核对、依赖解析受控；不承诺签名包或归档逐字节一致。
5. Android Maven/Gradle 缓存也影响离线构建；doctor 不解析这些依赖或检查整个缓存。首次准备依赖需要单独操作，之后的离线构建遇到缺项应明确失败。

## 后续构建操作模板

以下命令是后续 payload sync 与重建的操作模板。Android 最终输入已按此重建成功（见上文最终重建记录），后续输入仍需重新执行；iOS 仍缺完整 Xcode。`build:mobile` 仅生成 Web 资源，不能替代 native build。`cap sync` 会更新原生生成文件，需由原生工程负责人 review diff；它可能触发依赖解析，属于有副作用的后续步骤。

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

Android debug 构建使用已配置的私有 JDK、SDK 与私有 `GRADLE_USER_HOME`。下方是使用构建专用缓存的离线模板；最终重建即按此离线执行，首轮实际命令见执行记录，不含 `--offline`：

```sh
ASTARIA_BUILD_JAVA_HOME="/Users/mac/Library/Caches/ASTaria-build-tools/jdk21/jdk-21.0.12.1+1/Contents/Home"
ASTARIA_BUILD_ANDROID_SDK="/Users/mac/Library/Caches/ASTaria-build-tools/android-sdk"
ASTARIA_BUILD_GRADLE_USER_HOME="/Users/mac/Library/Caches/ASTaria-build-tools/gradle"
cd mobile/android
JAVA_HOME="$ASTARIA_BUILD_JAVA_HOME" \
ANDROID_HOME="$ASTARIA_BUILD_ANDROID_SDK" \
ANDROID_SDK_ROOT="$ASTARIA_BUILD_ANDROID_SDK" \
GRADLE_USER_HOME="$ASTARIA_BUILD_GRADLE_USER_HOME" \
PATH="$ASTARIA_BUILD_JAVA_HOME/bin:$PATH" \
  ./gradlew --offline --no-daemon :app:assembleDebug :app:testDebugUnitTest :app:lintDebug
```

`--offline` 要求已有 wrapper 发行包和依赖缓存；缺失时应失败，不为了让命令变绿而允许临时自动下载。SDK / JDK 前置检查就绪不能替代这次执行；保存真实退出码、具体 Gradle task 结果、实际 Build Tools 选择以及输出 APK 的路径和哈希，失败则记录失败原因。后续验收以相应构建的实际报告为准。debug APK 适合本地测试，使用 debug signing；它不是 release 分发包，也没有证明 Keystore 真机路径已经验证。

## TestFlight 账户与签名准备

TestFlight 需要有效的 Apple Developer Program 会员与团队配置；当前构建环境尚未配置这些条件。免费 Personal Team 的本地调试不能用于 TestFlight 分发。启用会员后，由签名负责人在 Xcode 和 App Store Connect 中选择/确认对应 Team，完成必要协议、角色权限及账户条件。本项目和 doctor 不保存 Apple 登录凭据、不读取签名钥匙串、不代替账户配置。

| 名称 | 用途与区别 |
| --- | --- |
| Apple Account / Apple ID | 登录和管理账户，不是签名证书 |
| Apple Development | iOS 等设备开发调试签名；不能代替 App Store Connect 分发签名 |
| Apple Distribution | 当前用于 App Store Connect / TestFlight 的分发证书类型；`iOS Distribution` 是历史相关名称，不是 Developer ID Application |
| Developer ID Application | macOS 在 Mac App Store 之外分发、配合 notarization 使用；不用于 iOS TestFlight |
| Provisioning profile | 连接正确 Team、App ID、能力与签名条件；与证书是不同对象，必须与归档/导出用途匹配 |

在开发者账户中注册显式 App ID `dev.wason.ASTaria`。在 App Store Connect 新建 iOS 应用记录，选择完全相同的 Bundle ID，填入名称、主语言、SKU 等信息，核对团队角色。不要因为桌面包名或其他平台工程而改成默认 Capacitor ID。首次上传前签名负责人准备正确分发证书/profile 或在 Xcode 的自动签名流程中配置它们；证书有效性须在实际归档前检查。

每个新的上传构建使用尚未使用、递增的 iOS build number。当前工程为 `1`；下面的 `2` 只是下一候选示例，必须人工核对 App Store Connect 中已接受的最高构建号。重做二进制后不要复用已上传的 build number。保持 marketing version `1.0`；iOS build number 和 Android versionCode 可各自递增，不强制修改桌面 `package.json` 版本。

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

`YOUR_TEAM_ID` 必须由签名负责人替换，不是有效凭据或当前 Team 声明。命令没有 `-allowProvisioningUpdates`；需要在线创建/更新 profile 时由用户在独立签名步骤处理。命令行版本 override 不修改工程源文件，应把实际归档版本/构建号记入本次构建记录。当前工程的静态 doctor 仍按源码版本检查，不能据此推断归档内最终版本。

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

export 的签名要求仍然存在；`destination=export` 表示本地导出，不是 upload。核对归档/IPA 的 Bundle ID、version、build number、签名 Team、嵌入 profile、资源和 secrets 插件注册，再做真机验证。本文件没有创建 ExportOptions、归档、IPA 或安装测试包。

## App Store Connect 待填写 / 待确认

1. **隐私标签**：按最终行为核对哪些数据只留在设备、哪些会因用户 AI 请求发送给用户选择的供应商。逐项确认聊天内容、附件/照片、日程、标识符、诊断等是否被开发者或第三方收集、用途、是否关联身份、是否用于追踪。供应商的数据保留与用途需要实际确认；不能仅因数据库在本地就勾选“无数据收集”。提供真实可访问的隐私政策 URL 和相应说明，隐私政策网站尚未建立。
2. **隐私资源与权限**：核对最终插件涉及的权限说明、required-reason API 与第三方 SDK 隐私清单。API Key 使用 Keychain 本身不代表所有插件的隐私清单和权限已审完。不要顺便加入与实现无关的权限、manifest 或声明。
3. **出口合规**：按最终 App/SDK 的加密实现回答 App Store Connect 问项：是否使用加密（含 HTTPS、Keychain、Keystore/AES-GCM 等实际用途），是否只使用标准/系统加密，是否有自研或非豁免算法，适用哪些地区/分发方式，是否需要相关备案、文件或年度报告。由责任人按 Apple 与适用主管机关规则确认豁免或申报义务。**不得自行断言免申报，也不自动设置 `ITSAppUsesNonExemptEncryption=false`。**
4. **TestFlight 信息**：填写真实的测试说明、反馈联系信息、审核联系信息、必要的测试账号/操作步骤。API Key 不应写入说明、截图、日志或资料备份；需要外部服务时明确说明测试者如何使用自己的配置。
5. **测试范围**：先确认内部测试人员还是外部测试人员。外部测试及公开邀请链接可能涉及 Beta App Review 和额外表单；不把当前“先 TestFlight”扩展为已决定公开邀请链接或正式上架。测试构建有有效期，之后仍需新构建。

账户、隐私和合规信息完成后，用户可在 Xcode Organizer 中按 App Store Connect 的分发/上传流程，或使用已配置的 Transporter 上传经核验 IPA。上传属于之后的明确操作；本轮 **upload 未执行**，没有发送 Apple 登录信息、证书、私钥或 App Store Connect API key。

## 真机验收与 Android 后续 release

在测试专用环境使用合成测试 token，验证保存、读取、覆盖、删除、重启、设备锁定/恢复与损坏记录的明确失败语义。确认日志没有 token，Web preview 的 read/write/remove 明确不支持，公开导出/备份/分享文件没有秘密；验证 iOS ThisDeviceOnly 的设备绑定及 Android noBackupFilesDir 的备份/恢复行为。ThisDeviceOnly 的源码属性不能代替系统备份的真机验证。Android 删除要验证 Keystore alias 与密文记录都清理；缺失或损坏密钥不能被当作未配置。

Android debug keystore 仅用于开发测试。未来 release 必须单独确定 app signing / upload key 策略；如采用 Google Play App Signing，app signing key 与 upload key 的职责也不同。既有同包名更新依赖签名连续性，不能随意换 key。妥善保管 release keystore、私钥、alias、密码和恢复资料：不可丢失，不进入 Git、应用资源、公开资料备份、日志或代理任务；应用内 API Key 的备份排除与发布签名材料的受控保管是两类要求。本轮没有准备正式 release keystore，也没有构建 release 包；debug 构建使用 Gradle 的标准 debug signing，不能作为正式签名验收。

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

以上链接用于之后人工核对；doctor 和本文档维护没有联网访问账户或下载工具链。

## 2026-10-15 · 首次引导与课表导入批次

首次设置、截图课表和 ICS 导入的共享源码完成后，再次执行手机类型检查与生产构建、`cap copy android`、`cap copy ios`，并离线执行上述 Gradle debug 构建/lint：`BUILD SUCCESSFUL in 15s`、288 tasks（6 执行、282 已是最新），App lint 0 错误、14 警告，原生单元测试仍为 `NO-SOURCE`。原路径的 Android debug APK 已更新，通过 v2 debug 签名、ZIP 完整性与 29 项当前 Web 资源一致检查；iOS 同步相同资源但没有 Xcode 编译或 IPA。全量源码 2,288 项、隔离生产界面 28 项通过；手机矩阵仍是 Chrome 模拟，不能代表 Huawei 或 iOS 真机。手机云模型范围仍为 DeepSeek，不提供桌面新增的兼容 API 服务。

本节为该批次当时的记录；其中的 Android debug APK 与本机桌面候选已在 2026-10-15 晚批次被替换（见下节），2,288 项与 29 项均按该批次理解。

## 2026-10-15 晚批次替换（2026-10-16 上午执行）

此节只保留为 10 月 15 日源码批次的历史记录；其候选已由下方 2026-10-16 最终本机批次替换。

10 月 15 日晚批次在原 RC1 路径上就地替换了上一批候选，替换完成时间 `2026-10-16T00:23:57.873112+00:00`；当时共记录 1,633 个源文件哈希，旧的重复暂存包删除并释放约 1.28 GB。该批证据见 `artifacts/mobile-rebuild-2026-10-15/`；**该批当前产物哈希、文件数和构建状态均为历史值**。

| 平台 | 本批事实 | 证据 |
| --- | --- | --- |
| macOS | 已安装 App 静态清点 **909 个文件、0 问题**（182 模块 / 527 import / 0 动态 import 被拒 / electron true / 7 个依赖 / 4 份许可正文与源一致）；DMG 内容检查通过（App 文件逐字节一致 909、`Applications` 快捷方式、说明与背景匹配、透明桌面图标字节保留、提醒辅助程序图标一致、**未公证**）；`/Applications/ASTaria` 为原生 Finder 替身、透明图标已应用，替身指向 `desktop-builds/1.0.0-rc.1/ASTaria-1.0.0-rc.1-mac-arm64/ASTaria.app` | `verify-mac-installed.json`、`dmg-final-contents.json`、`applications-alias.json` |
| macOS 运行 | 真实 Electron **隔离**冒烟通过（`ASTARIA_SMOKE_PASSED`，React / API / SQLite / WebGL2 / nodeIntegration 均 true；日志同时记录窗口尺寸、fullSizeContent 与原生按钮字段），检查时间 `2026-10-16T00:17:42.971Z` | `mac-installed-smoke.log` |
| Windows | portable 已安装副本静态清点 **708 个文件、0 问题**（模块/import 与 macOS 相同）；**本批没有 Windows 实机运行** | `verify-windows-installed.json` |
| Android / iOS | 已安装 payload 检查通过：**52 个文件**在 Android 与 iOS 两端工程各检查 52 项、失败 0；APK `desktop-builds/1.0.0-rc.1/android/ASTaria-1.0.0-rc.1-android-debug.apk`，SHA-256 `160333e16343576fb727017b87106ce366477239346a7637878ba8023a942907` | `android-installed-payload.json` |
| Android 构建 | 离线 debug 构建/lint 记录为 `11s`、`288 tasks`、App lint 0 错误 14 警告，原生单元测试 task 仍为 `NO-SOURCE` | 本批 Gradle 运行记录（Gradle 日志不在本次声明的证据文件内，仅记录上述数字） |
| iOS | 仅同步 Web 资源，**没有 Xcode 编译、没有 IPA** | `android-installed-payload.json`（iOS 侧 52 项一致） |

本批当前的产物哈希（本机核对用，不是公开更新签名清单）：

| 产物 | SHA-256 |
| --- | --- |
| `ASTaria-1.0.0-rc.1-mac-arm64.zip` | `c243120eb8bc29a92c719e5fb88736f65b356d17cc36e65d3ce4d6893383de17` |
| `ASTaria-1.0.0-rc.1-mac-arm64-adhoc.dmg` | `71c8f3de698da55214e7b8df82a3d80fd9551bdd6e7ad8e1adadb4670f843870` |
| `ASTaria-1.0.0-rc.1-win-x64-setup.exe` | `9964f5e91828b2ad7d0ed361afb8dcb318f39ea88cd78c123f4636d0806351f8` |
| `ASTaria-1.0.0-rc.1-win-x64-portable.zip` | `2f7e75e2d84896832948bde579e7ce0db07c0d5aead8c4f59c992e496f1ddf9d` |
| `ASTaria-1.0.0-rc.1-android-debug.apk` | `160333e16343576fb727017b87106ce366477239346a7637878ba8023a942907` |

本批**没有**：Windows 实机安装/交互/升级回退验证、Android 或 iOS 真机验证、iPhone/iPad IPA、Developer ID 签名与 Apple 公证。本批的任何静态清点或隔离冒烟都不构成设备验收、功耗结论或帧率结论。

## 2026-10-16 · 手机四页样式早期源码与预览记录

最初修改手机四个页面（工作台 / 日程 / 余时 / 设置）的材质、字体、边距与动效时，属于**源码与预览范围**；随后已由文末 2026-10-16 最终本机候选批次重新打包。下文保留的早期测试数和旧包状态是历史事实，不代表最终包。

- 下缘闪边已在实际 IAB 复现，候选通过随场景出帧的等几何 SVG 失效处理，在本机连续 120 帧保持折射。**2026-10-16 用户在正常手机预览中确认该下缘折射保持稳定**；Mate XT 与 iOS 仍待验收，不能记为所有设备已修复；这一处理不影响 Android 自动 CSS 路径。
- 当前 UI 验收尚未记录，由主代理稍后补；本文件不提前给出该迭代的验收结论。
- 该迭代当时的源码测试为 **2,342 项（2,341 通过、0 失败、1 跳过）**，日志 `artifacts/mobile-detail-2026-10-16/source-tests.log`。这只是**当时源码批次**的结果，不代表随后仍在继续迭代的源码已经全部重测。

早期源码记录为 2,343 项中 2,342 通过、1 跳过；桌面和手机生产构建通过。当时新的界面和 SVG 修复尚未同步进 Android/iOS 工程；**该阶段随后由下方最终本机候选批次完成同步与重打包**。各阶段源码测试数字按相应记录理解。

## 2026-10-16 · 最终本机候选打包

当前源码已重新构建并同步到 Android/iOS Web payload；用户退出运行中的 Mac App 后，Mac App、DMG、ZIP、Windows setup/portable 和 Android APK 已替换到原 `desktop-builds/1.0.0-rc.1` 路径。重复的旧 Mac 候选与本轮临时包已清理，只保留一个版本目录。没有 GitHub 推送或公开 Release。

| 产物 | SHA-256 | 核验 |
| --- | --- | --- |
| `ASTaria-1.0.0-rc.1-mac-arm64-adhoc.dmg` | `3068d78bd3588325ee3df38448003400554ae864e203ed8f911bef99e0d77e6d` | ad-hoc、未公证；只读 DMG 内 910 个 App 文件一致 |
| `ASTaria-1.0.0-rc.1-mac-arm64.zip` | `7ed35173e4413b6c42a04484c209d7e5eca21534ff5c950e9e9424c4f1d1ff64` | App 静态核验和隔离启动通过 |
| `ASTaria-1.0.0-rc.1-win-x64-setup.exe` | `115dc60ae3728ade3faa0bf4d5a33d3e40fe4238edbc3ec26a454c31f12ebf6d` | 未 Authenticode；静态负载和透明图标通过 |
| `ASTaria-1.0.0-rc.1-win-x64-portable.zip` | `352c82fa89eb4b5a99a3855013225b8397835de3827fa868fb11c24e6fab3cb0` | 未 Authenticode；静态负载通过 |
| `ASTaria-1.0.0-rc.1-android-debug.apk` | `a9eb111c12aae690ffd57f60c77667bb8a023d68cab516318d3f7c3a3b023546` | v2 debug 签名和 ZIP 完整性通过 |

本批 `npm test` 为 2,343 项（2,342 通过、1 跳过、0 失败）；Android Gradle `BUILD SUCCESSFUL`、288 tasks、App lint 0 错误/15 警告，`testDebugUnitTest` 仍为 `NO-SOURCE`。APK、Android 工程、iOS 工程和 `dist-mobile` 各核对 52 个 Web 资源，失败 0。iOS 没有 Xcode 编译、IPA 或 TestFlight 上传；Windows、Android/iOS 真机和功耗仍待验收。完整证据见 [`artifacts/package-2026-10-16/package-summary.json`](../artifacts/package-2026-10-16/package-summary.json)。
