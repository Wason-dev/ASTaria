# macOS Developer ID 签名与公证准备

`scripts/macos-signing.mjs` 提供签名计划、独立本机签名入口和最终清单刷新接口。本文说明可复用流程，不记录具体证书配置或单次构建状态。计划和纯测试通过只能证明流程准备有效；发行状态必须根据实际签名、公证与成品检查结果确定。

## 状态与发布依据

| 状态 | 含义 | 公证状态 |
| --- | --- | --- |
| `prepared` | 参数、代码清单和命令计划有效；尚未运行签名 | `false` |
| `adhoc` | 经过 `codesign --verify`，签名报告为 `Signature=adhoc` | `false` |
| `developer-id` | 所有代码签名通过，精确 Application identity、team、可信时间戳和 hardened runtime 已核验 | `false` |
| `notarized` | App 与最终 DMG 都有 `Accepted` 回执、stapler ticket 校验、Gatekeeper 成功，并关联最终 DMG 哈希与 App CDHash | `true` |

签名、公证和更新清单的 Ed25519 发布者签名是不同检查。`signed` 文件名、计划成功或 `notarytool` 进程退出成功都不能证明公证通过。Developer ID 身份也不能替代 `desktop/releaseTrust.mjs` 中已有的 Ed25519 信任锚。

## 前置条件与输入

签名环境需要由 macOS Keychain 管理的 **Developer ID Application** 身份，以及与该身份一致的十位 Apple team ID。不能使用 Developer ID Installer、Apple Development、自动选择的默认身份或只给团队名称。App 本机签名入口通过 `security find-identity -v -p codesigning` 精确匹配唯一身份，再用该身份的证书指纹调用 codesign；DMG 入口核验已有 App 的唯一签名身份，并直接使用 options 中的精确 identity，不查询默认身份。

公证只引用一个已经存在的 `notarytool` Keychain profile 名。此模块不购买或导入证书，不创建 profile，不接收 Apple ID、密码、应用专用密码、API 私钥、Keychain 密码或私钥文件。身份名称与 team ID 是公开签名元数据；profile 在审阅输出中被隐藏，子进程输出不会被打印到日志。

签名输入应为独立的公开 **构建副本**。执行入口要求 build-info 中版本、架构、平台、名称、bundle ID 和干净源码提交一致。签名会修改副本中的代码及 helper 哈希，因此应使用专门的发行工作目录。未配置证书的环境可以构建计划；实际执行需要匹配的有效签名身份。

示例公共配置如下。路径与示例身份均为占位符；必须替换为经过审阅的构建副本、真实精确身份和已有 profile。下面省略了完整 Electron 代码清单，因此只能用来说明字段，不能作为正式签名清单。

```json
{
  "app": "/release-work/ASTaria.app",
  "arch": "arm64",
  "version": "1.0.0",
  "identity": "Developer ID Application: Example Software (AB12CD34EF)",
  "teamId": "AB12CD34EF",
  "keychainProfile": "ASTaria-Notary-Existing",
  "scratch": "/release-work/.fresh-signing-scratch",
  "artifact": "/release-work/ASTaria-1.0.0-mac-arm64-signed.dmg",
  "targets": [
    { "path": "Contents/MacOS/Electron", "kind": "macho" }
  ],
  "compatibility": {
    "allowUnsignedExecutableMemory": false,
    "disableLibraryValidation": false
  }
}
```

`targets` 要覆盖指定 App 内所有 Mach-O 文件，包括 Electron、framework 二进制、Renderer/GPU/Plugin Helper、原生 `.node`/动态库、ASTaria Keychain helper、提醒 helper，以及所有嵌套 `.app`/`.framework` 容器。`discoverMacSigningTargets(app)` 能从明确指定的构建副本生成清单；它不跟随 framework symlink 二次遍历，并拒绝指向 App 外的链接。执行前会再次扫描，清单不同则停止；构建内容变化后应重新生成清单与计划。签名原生代码前会逐个运行 `lipo -archs`：`x64` 必须实际为 `x86_64`，`arm64` 必须实际为 `arm64`。

`version` 必须为三段 canonical SemVer，例如 `1.0.0`、`1.0.0-rc.1` 或 `1.0.0-beta.12.1`；不接受 `v1.0` 或前导零。`scratch` 必须是 App 外尚不存在的独立目录，其父目录必须为规范路径；`artifact` 必须与 App、scratch 分离，并使用 `ASTaria-{version}-mac-{arch}-signed.dmg` 名称。

`createMacSigningPlan(options)` 不读取 Keychain 或构建包，不运行命令。CLI 的计划入口只读取指定公共 JSON 文件：

```sh
node scripts/macos-signing.mjs --plan /release-work/public-signing-options.json
```

本机签名入口：

```sh
node scripts/macos-signing.mjs --execute-local-signing /release-work/public-signing-options.json
```

程序接口为 `executeLocalMacSigning(options, { confirmLocalSigning: true })`，只允许 macOS。`confirmLocalSigning` 是调用方显式选择执行的布尔开关，CLI 的 `--execute-local-signing` 设置这个开关。这个入口执行本机签名和验签，不执行计划中的 `later` 公证或打包步骤。codesign 的 `--timestamp` 是 Developer ID 可信时间戳要求；真实签名时它可能联系 Apple 时间戳服务，不能把这一步称作完全离线操作。

## 模块接口与打包集成

所有接口由 `scripts/macos-signing.mjs` 导出，使用 Node 内置模块，无新增依赖。

| 接口 | 输入与输出 | I/O 边界 |
| --- | --- | --- |
| `validateMacSigningOptions(options)` | 返回校验后的参数副本，`targets` 按深度由内向外排序 | 纯函数 |
| `electronEntitlements(compatibility)` | 返回 Electron entitlements plist 文本 | 纯函数 |
| `createMacSigningPlan(options)` | 返回冻结的 `{ schemaVersion: 1, status: 'prepared', notarized: false, options, local, later }` | 只构建计划 |
| `reviewMacSigningPlan(plan)` | 返回适合展示的计划副本，隐藏 profile 名 | 纯函数；日志使用此输出 |
| `discoverMacSigningTargets(app, files?)` | 返回完整 `{ path, kind }[]` 清单，`kind` 为 `macho`、`app` 或 `framework` | 只读取指定构建副本 |
| `verifyMacSignature(report, options, { verified, hardenedRuntime }?)` | 根据成功验签后的报告返回 `adhoc` 或 `developer-id`、`appCDHash`；不会返回 `notarized` | 纯校验；`verified` 默认 `false` |
| `executeLocalMacSigning(options, dependencies?)` | 返回 `developer-id`、`notarized: false`、App 路径、架构、版本、team ID、CDHash | 本机签名、验签与 helper 哈希刷新；首个失败即停止 |
| `refreshMacSigningManifest(input, { hashAsset }?)` | 返回 `{ status, manifest, checksum, needsReleaseManifestSignature: true }` | 默认只读取最终 DMG 以计算哈希和大小，不写清单 |
| `macSigningArguments(argv)` | 解析计划或显式执行入口；帮助参数返回 `null` | 纯函数 |

`executeLocalMacSigning` 的 `dependencies` 可注入 `run`、`files`、`discover`、`platform` 和 `onStep`；生产调用使用默认实现，纯测试使用内存文件与假命令 runner。`onStep` 只接收 `{ id, status }`，不接收子进程输出或认证材料。未设置 `confirmLocalSigning: true` 不会执行命令。

清单刷新输入为 `{ manifest, options, appSignatureReport, dmgSignatureReport, appVerified, dmgVerified, notarization? }`。`appVerified` 与 `dmgVerified` 默认 `false`，应来自成功的实际 `codesign --verify`；传入的 `manifest.buildInfo` 应重新读取外层 App 签名前已更新 helper 哈希的构建信息。没有公证证据时，签名验证成功只得到 `developer-id`。

`notarization` 要包含 App 与 DMG 各自的 `appSubmission`、`dmgSubmission`（`status: 'Accepted'` 与不同的 UUID `id`），以及值均为 `0` 的 `appStaplerExitCode`、`dmgStaplerExitCode`、`appGatekeeperExitCode`、`dmgGatekeeperExitCode`。其中 stapler 退出码应来自 `stapler validate`。还须提供与当前结果一致的 `artifact`、`finalSha256`、`appCDHash`、`teamId`，才能返回 `notarized`。缺失或不匹配的已提交证据会使刷新失败。

## Developer ID DMG 入口

`scripts/package-dmg.mjs` 未传 `--signing-options` 时保留原 arm64/ad-hoc 路径：要求 ad-hoc App，输出 `ASTaria-{version}-mac-arm64-adhoc.dmg`、对应 checksum/manifest 和 `install.txt`。`--app`、`--out`、`--instructions` 仍是必需参数。

Developer ID 路径必须显式指定公开 options 文件，使用与 App 签名计划相同的 schema。例如，与上面的公开配置对应的命令为：

```sh
node scripts/package-dmg.mjs \
  --app /release-work/ASTaria.app \
  --out /release-work \
  --instructions /absolute/path/to/ASTaria/INSTALL.md \
  --signing-options /release-work/public-signing-options.json
```

`options.app` 必须等于实际 App 的规范路径，`options.version` 必须等于包内 `package.json` 与 `build-info.json` 版本，`options.artifact` 必须等于输出目录内预期 signed DMG 的完整路径。构建信息必须含匹配的名称、bundle ID、平台、架构、有效源码 commit 和 `source.dirty: false`。不能凭修改 options 或文件名把 arm64 构建当成 x64。

入口复用 `validateMacSigningOptions`、`discoverMacSigningTargets`、`verifyMacSignature` 与 `refreshMacSigningManifest`。它重新扫描完整代码清单，对原 App 和拷贝执行 `codesign --verify --deep --strict`，并逐项验证代码签名和每个 Mach-O 的 `lipo -archs`。App 与各子项必须拥有唯一匹配的 Developer ID Application leaf identity、team ID、runtime 标志和可信 timestamp；拷贝的根及子项 CDHash、包信息和构建信息必须保持一致。打包过程不重签 App，不更新 App 内资源或 helper 哈希。

DMG 使用精确 identity 与 `--timestamp` 签名，不附加 Electron runtime/JIT entitlements；随后核验 DMG 实际签名身份、team、timestamp 与 image。它不调用 `security`、`notarytool`、`stapler` 或 `spctl`。签名时间戳仍可能联系 Apple 服务，运行这个入口需要有效证书；纯测试通过不代表已实签。

所有 DMG 修改和验签结束后，入口读取暂存 DMG 的实际字节重算 SHA-256 与大小，生成 `ASTaria-{canonical version}-mac-{arch}-signed.dmg`、`.dmg.sha256` 和同 stem 的 `.manifest.json`。清单固定为 `signing: "developer-id"`、`notarized: false`，即使输入 App 已 staple 也不能推断新 DMG 已公证。保留原显式 `--sign-manifest` 选项；只有指定该选项才调用独立 Ed25519 清单签署函数，并排在最终哈希之后、sidecar 写入之前。默认不读取发布私钥。若还要对 DMG 公证并 staple，应在这些改动结束后再次刷新 checksum/manifest，并最后重新签署发布清单。

| `package-dmg.mjs` 导出接口 | 契约 |
| --- | --- |
| `argumentsFor(argv)` | 解析原 CLI 参数及可选 `--signing-options`，返回 `signingOptionsFile`；未指定时保持原参数形状 |
| `validateDmgSigningInput({ options, app, out, version, buildInfo, plist })` | 纯校验，严格绑定公开 options 与真实包元数据，返回校验后的 options |
| `verifyDmgDeveloperSignature(report, options, verification)` | 在共享签名校验之上要求唯一身份与报告字段；`verification.verified` 必须来自成功验签，DMG 使用 `hardenedRuntime: false` |
| `packageDmg(args, dependencies?)` | 返回 `{ artifact, manifest, checksum }`；支持注入 `platform`、`files`、`run`、`copyBundle`、`discover`、`hashAsset`、`signManifest`、`onStep`、`now` |

命令 runner 的结果契约为 `{ status, stdout, stderr, error? }`，非零退出码或异常都会立即停止；错误只记录阶段，不回显子进程输出或认证内容。`onStep` 只收到阶段 ID 与状态。失败时不继续验签、哈希、签署清单或导出文件；只保留该次运行创建的隔离 staging 供本地检查。已有输出不覆盖。

## Electron hardened runtime 与 entitlements

所有代码签名使用 `--options runtime --timestamp`，由内向外逐个签名；不使用 `codesign --deep` 签名。`--deep` 只出现在最终 `--verify --deep --strict --verbose=2` 验签步骤。

默认 Electron 主进程和 Electron Helper 启用 `com.apple.security.cs.allow-jit`，满足现代 Electron/V8 的 JIT 需要。`allow-unsigned-executable-memory` 和 `disable-library-validation` 默认关闭，只有针对实际 Electron 版本、原生模块及两种架构验证后才能通过 `compatibility` 显式开启。现有 ad-hoc packager 使用了这两项兼容权限；不能因此直接断言最小 Developer ID 权限已经适用于当前运行时。首次成品测试若出现 JIT、原生模块或库加载失败，应核查 Electron 支持要求，再选择必要权限并重新构建签名计划。

Keychain 和提醒 helper 不继承 Electron 的 JIT 权限。普通 framework、动态库也不附加不必要的 App entitlements。流程不启用调试权限 `get-task-allow`，不把 Developer ID 分发等同于 Mac App Store sandbox，也不关闭 Gatekeeper。

签名会改变原生 helper 字节。独立模块在所有内部签名完成后重新计算 `build-info.nativeHelpers.keychainSha256`，写回公开构建信息，再签最外层 ASTaria.app。修改 Info.plist、图标、源码、build-info 或任何密封资源都必须发生在最外层签名之前；之后再改内容会使验签失效。

## 公证与分发顺序

1. 从清洁、正确架构的 Electron 构建副本开始，核验精确证书身份与每个 Mach-O 架构；写入该次运行的 entitlements。
2. 按深度由内向外签 Mach-O、framework、嵌套 Helper App，更新原生 helper 哈希，最后签 ASTaria.app。验证整个 App，并对每个子项独立 `codesign --verify --strict`（包括非标准 `Resources/app/bin` 位置），再检查签名 authority、team、timestamp 和 runtime 标志。任一步失败立即停止，失败副本不能作为成品。
3. 用 `ditto -c -k --sequesterRsrc --keepParent` 创建 App 公证 ZIP，然后执行 `xcrun notarytool submit <zip> --keychain-profile <已有名称> --wait --output-format json`。必须解析 JSON 的 `status: Accepted` 和 submission ID；`In Progress`、`Invalid`、超时或无法解析都不能继续。ZIP 本身不能 staple，接受后对 ASTaria.app 执行 `xcrun stapler staple`、`xcrun stapler validate` 和 `spctl --assess --type execute --verbose=2`。
4. 将 `plan.options` 写为公开 JSON，然后执行计划中的实际 `package-dmg.mjs --signing-options` 命令，用已验证、已 staple 的 App 制作独立 signed DMG。入口保留 App 签名及 ticket，完成 DMG 签名、验签、image 验证与公证前的 checksum/manifest。分发容器包含公开安装说明与 `/Applications` 快捷方式。
5. DMG 已由打包入口完成精确 Developer ID 时间戳签名，不重复签名。用 `notarytool submit <dmg> --keychain-profile <已有名称> --wait --output-format json` 单独提交并确认 `Accepted`。
6. 对最终 DMG 执行 `xcrun stapler staple`、`xcrun stapler validate` 和 `spctl --assess --type open --context context:primary-signature --verbose=2`。记录 App、DMG 各自回执、校验退出码与该次 artifact 路径、最终 DMG SHA-256、App CDHash、team ID。
7. 所有签名和 staple 改动结束后，再读取最终 DMG 字节，重算 SHA-256 和 sizeBytes，写对应 `.dmg.sha256` 和 `.manifest.json`。传入的清单模板须包含刚读取的、已更新 helper 哈希的 buildInfo。`refreshMacSigningManifest` 返回更新后的清单与 checksum 文本；它不会写文件或读取发布私钥。它会丢弃旧 Ed25519 签名、旧 ZIP/资产列表和未重新检查的 imageVerified 等标志，要求独立发布步骤对最终清单重新签名并通过既有 `verifyReleaseManifest` 验签。

计划里的 `later` 数组先安排公开 options JSON 写入，再调用实际 DMG 打包命令，之后保留公证、staple、最终验签与清单刷新步骤。公开文件默认路径为输出目录下的 `ASTaria-{version}-mac-{arch}-signing-options.json`，安装说明默认指向仓库 `INSTALL.md`。`write-dmg-options` 和 `refresh-manifest` 是集成步骤；后者必须替换打包命令生成的公证前 sidecar，绑定最终回执并最后签署清单。模块没有执行整个 `later` 数组的入口。集成代码必须按步骤解析回执并核验成品关联，不能仅循环执行其中的命令。收到 Apple 错误时应在受控本机环境审阅诊断，日志不能输出认证材料；这个模块的失败信息只显示停止阶段。

`refreshMacSigningManifest` 的 notarization 证据参数必须由负责实际执行的集成代码生成，不能用外部传入的 `notarized: true` 或已有清单标志充当证据。纯校验无法向 Apple 独立证明外部回执真实性，集成代码必须把实际回执与当前构建的命令结果绑定。缺少这些证据时最多报告 `developer-id`、`notarized: false`。Developer ID 清单沿用 `signing: "developer-id"`，是否已公证单独用 `notarized` 字段表达。

## arm64 / x64 集成与验收缺口

签名与 DMG 模块不构建 Electron 运行时或原生依赖。无 signing-options 的 DMG 路径仍为 arm64/ad-hoc；Developer ID DMG 路径支持 arm64/x64 参数并核验实际代码架构，但两种架构的 App 构建与真实成品均需分别验证。接受 x64 options 不代表已有 arm64 App 构建已完成 x64 支持。

| 项目 | arm64 | x64 / Intel |
| --- | --- | --- |
| App 构建 | 需要 arm64 Electron、原生 helper 与依赖；尚待 Developer ID 成品验证 | 需要独立 x64 Electron、原生 helper 与依赖；不能把 arm64 包改名成 x64 |
| DMG 构建 | 已有显式 Developer ID 接口与纯测试；保留原 arm64/ad-hoc 默认路径，尚待成品验证 | 同一接口接受 x64 并逐个核验 x86_64 Mach-O；尚待真实 x64 App 输入及成品验证 |
| 签名模块 | 可构建/验证 arm64 计划；无证书实签验证 | 接受 x64 计划并要求每个 Mach-O 为 x86_64；不代表 x64 构建已经可用 |
| 成品验收 | 证书签名、Apple 公证、隔离下载首次启动、更新、Keychain、提醒 helper 尚待真实包验收 | 需独立 Electron x64 运行时、x64 原生 helper/依赖、Intel 实机或对应环境测试；尚未验收 |

打包集成需统一 signed 文件名 `ASTaria-{canonical version}-mac-{arch}-signed.dmg` 及同 stem 的 manifest；固定输入源码、构建来源和两种架构各自产物后，再执行实际签名。任何架构的签名、公证与验收都不能推断另一架构也已完成。安装和发布文档应对应实际已验证的成品状态；只有具备 signed/notarized 成品后，才能描述相应的分发能力。

## 纯验证

```sh
node --test scripts/macos-signing.test.mjs scripts/package-dmg.test.mjs
node --check scripts/macos-signing.mjs
node --check scripts/package-dmg.mjs
```

测试用内存文件接口和假命令 runner 验证严格参数、entitlements、由内向外顺序、ad-hoc 兼容、App 拷贝保持一致、失败即停、两种架构、唯一身份/runtime/timestamp 校验、状态区分、最终字节哈希与旧签名清除，以及 checksum/Ed25519 的最终执行顺序。测试不会调用 security、codesign、hdiutil、notarytool、stapler、spctl，也不会读取 Keychain、证书、密码、私钥或现有包。

## DMG 展示资源与构建环境

DMG 打包先在独立可写 staging 映像中加入背景和 Finder 元数据，再卸载并转换为只读 UDZO。根目录可见 App、Applications 快捷方式与底部单行说明入口；隐藏 `.background` 和 `.DS_Store` 是展示资源，说明文件使用透明装饰图标。该步骤不修改输入 App 的字节或签名，转换后继续执行原有容器签名、验签、image 验证和清单流程。

构建机需要 Python 3，以及只供打包使用的 `ds_store==1.3.1`、`mac_alias==2.2.2`；可安装到独立工具目录并用 `ASTARIA_DMG_LAYOUT_MODULES` 指定，不加入应用运行时依赖。`ASTARIA_DMG_PYTHON` 可指定 Python 可执行文件。透明说明图标使用系统 clang/AppKit 编译 staging helper；helper 不随 DMG 分发。依赖缺失、写布局或卸载失败时打包停止，不把半成品标为可分发。

Finder 对已打开窗口可能保留本机的大小、工具栏和侧栏设置，已有窗口与首次打开磁盘的显示需分别核对。布局默认尺寸为 900×560。成品验收应分别核对首次挂载与已有窗口中的背景、拖拽箭头、底部说明文字和说明入口。
