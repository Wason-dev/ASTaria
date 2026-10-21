# ASTaria 图标源与导出

- `new/astaria-icon-transparent-2048.png`：用户批准的 **macOS / Windows 默认桌面源**，2048×2048 RGBA；
  按 1.1 倍居中放大后透明输出，不加黑底、圆角 tile 或其他背景，不重绘、不改色。
- `new/astaria-icon.svg`：用户提供的 **Android / iOS / Web 黑底成稿主源**，`viewBox="0 0 1600 1600"`，银灰三瓣配 `#282828` 黑底；
  文件内只有字面实色与 path/clipPath 几何，没有渐变、内嵌位图、滤镜或 transform。
- `new/astaria-icon-transparent.svg`：同一 SVG 图案去掉黑底矩形的透明源，用于手机/Web 的安全区合成、透明前景与单色遮罩；不替代桌面批准的 PNG。
- `old/`：历史图标资料（含旧母版、预览与旧说明），**仅作记录，不要编辑，也不要作为当前生成源**。

两个 SVG 主源除黑底矩形外逐字相同；`#282828` 是手机/Web 成稿底色。各平台保留指定源的图案与颜色，不新增渐变、不把主图压平成白色、不重绘几何。

## 可重复导出命令

导出使用已安装的 Sharp 图形库，脚本本身不安装任何依赖，也不需要联网：

```bash
node scripts/generate-icons.mjs \
  --out public \
  --android-res mobile/android/app/src/main/res \
  --ios-assets mobile/ios/App/App/Assets.xcassets \
  --sharp /absolute/path/to/your/node_modules/sharp/dist/index.mjs
```

- `--sharp` 传本机已安装 Sharp 的模块文件绝对路径；Sharp 0.35+ 的 ESM 入口是 `node_modules/sharp/dist/index.mjs`，
  0.34 及更早是 `node_modules/sharp/lib/index.js`。本机环境能直接 `import 'sharp'` 时可省略该参数。
  本仓库的开发依赖里没有 Sharp，因此这里不做任何安装：请使用你自己环境里已有的副本。
- 省略 `--out` / `--android-res` / `--ios-assets` 时使用脚本内置的同一组默认目录；改传临时目录即可先预览。
- `--source`（透明 SVG）与 `--opaque-source`（带黑底 SVG）默认指向 `design/icon/new/`；它们只控制手机/Web 资源。
- `--desktop-source` 可指定已批准的 2048×2048 RGBA PNG，默认使用 `design/icon/new/astaria-icon-transparent-2048.png`。
  所有输入只读，输出不会覆盖输入。桌面源缺失、格式/尺寸不符、全不透明或全透明时，在写出任何资源前失败；不会回退到 SVG 或黑底。
- 桌面每个目标尺寸 `size` 都直接读取 PNG 母版，用 Lanczos3 缩放到 `round(size * 1.1)`，
  再从 `floor((放大尺寸 - size) / 2)` 起居中裁切成 `size × size`；与历史 `artifacts/v1-transparent-icon/prepare-icons.mjs` 一致。
- 先完成全部源文件解析、Android 矢量转换和栅格化，再写出 41 项资源；同一工具链重复执行得到相同结果。
- macOS 打包器默认读取 `public/astaria-icon-1024.png` 生成 App 与提醒辅助程序的 ICNS；Windows 打包器默认读取
  `public/astaria.ico`，用于 EXE 与 NSIS 安装/卸载图标。正常打包沿用这两个默认输入，无需临时 `--icon` 覆盖。
- PNG 母版是 Git 忽略的本地输入，不要 `git add -f` 或改变忽略规则；生成机器须已有该素材，分发产物只使用导出的图标。

## 源与输出表

| 输出 | 读取的源 | 底与外形 | 用途 |
| --- | --- | --- | --- |
| `public/astaria-logo.svg` | 主源（黑底）逐字节复制 | `#282828` 底，完整 1600 方块 | 网页与文档展示的矢量主图 |
| `public/astaria-logo.png` | 主源 | `#282828` 底，完整 viewBox，RGB 无 alpha | 网页与商店展示用 1024 位图 |
| `public/astaria-icon-1024.png` | 批准的透明 2048 PNG | 1.1 倍居中放大，1024 RGBA，无附加底色或圆角 tile | macOS App / ICNS 主图 |
| `public/favicon.png`、`apple-touch-icon.png`、`pwa-192x192.png`、`pwa-512x512.png` | 主源 | `#282828` 底，完整 viewBox，RGB 无 alpha | 网页图标、iOS 主屏与 PWA |
| `public/maskable-512x512.png` | 透明源 | `#282828` 底 + 图案占画布 78%，完整轮廓位于 80% 安全圈内 | Android PWA maskable |
| `public/astaria.ico` | 批准的透明 2048 PNG | 每档直接从 PNG 母版 1.1 倍居中放大，16/24/32/48/64/128/256 七档 RGBA，无附加底色 | Windows 应用与安装包图标 |
| `mipmap-*/ic_launcher.png`、`ic_launcher_round.png` | 主源 | `#282828` 方图；round 只按圆形削减 alpha，不改色 | Android 传统 launcher 图标 |
| `mipmap-*/ic_launcher_foreground.png` | 透明源 | 图案占 108dp 画布的 60/108，其余透明 | Android adaptive icon 前景 |
| `values/ic_launcher_background.xml`、`values/colors.xml` | 主源黑底 | `#282828` | adaptive icon 背景与启动底色 |
| `drawable-*/ic_launcher_monochrome.png` | 透明源 | 原 alpha + 白色 RGB | Android 13+ 主题图标（系统单色 mask） |
| `drawable-*/ic_stat_astaria.png` | 透明源 | 图案缩到 24dp 的 90%，原 alpha + 白色 RGB | Android 状态栏通知图标 |
| `drawable/astaria_splash_icon.xml` | 透明源 | 由源几何直接转换，`#282828` 由启动主题提供 | Android 12+ 启动图标（矢量） |
| `AppIcon.appiconset/AppIcon-512@2x.png` | 主源 | 1024 像素 RGB，**无 alpha** | iOS App 图标 |
| `Splash.imageset/splash-2732x2732*.png` | 透明源 | `#282828` 底 + 图案缩到 24% | iOS 启动图 |

白色只出现在 Android 通知图标与主题单色 mask 两个输出系列；其余输出保留源图原有的银灰实色。

这组资源同时是 `1.0.0-rc.1` 本地候选安装说明的基础：安装步骤与平台边界见 [INSTALL.md](../../docs/INSTALL.md)
（仓库根目录的 `INSTALL.md` 是同一份正文，纯文本版 `install.txt` 供打包使用）。

## 桌面透明输出验收

```bash
node --test scripts/mobile-native-icons.test.mjs scripts/nsis-icon.test.mjs scripts/windows-branding.test.mjs
```

- 批准 PNG 的 SHA-256：`c037755c2c375372b6c201a9ffa43351d79ca54b9e36f0322670bf0a1353b846`。
- `mobile-native-icons.test.mjs` 使用独立转换得到的完整 RGBA 像素摘要，检查 1024 PNG 与 ICO 全部七档，
  包含图案内部的 RGB/alpha；仅保留透明角落的黑底 tile 也会失败。测试本身不依赖 ignored PNG 或 Sharp。
- 像素基准由 Sharp 0.35.5 / libvips 8.18.7 按上述历史转换生成。升级工具链若造成像素变化，须重新对照批准 PNG 验证，不能直接接受新的输出摘要。
- 手机/Web 的原有像素、黑底、maskable 安全圈、Android 单色遮罩与 iOS 无 alpha 检查继续保留；NSIS 测试逐像素检查 ICO 转 DIB 的 RGB/alpha。

## 历史本地试用：透明底图标（2026-10-14）

- 本节记录当时的**本地候选试用**，当时尚未成为默认导出，也未公开发布：主代理以 `new/astaria-icon-transparent-2048.png`
  （2048×2048 RGBA）为源，保留原色与图案等比缩放导出 macOS ICNS 与 Windows ICO，只覆盖本机候选，
  没有重绘几何、没有改色、没有新增渐变。
- 在等比缩放的基础上，图案以中心为基准放大约 10%（`glyphScale 1.1`）；原轮廓没有被裁掉，透明边缘保留。
- 本机候选的 macOS App、提醒辅助程序与**应用程序目录里的 ASTaria 原生替身**使用这套透明图标：该替身是指向
  `desktop-builds` 中 Mac 候选的原生 Finder alias。DMG 内的 `Applications` 只是系统文件夹快捷方式，
  没有给系统文件夹换图标。Windows 的 EXE 与 NSIS 安装/卸载图标使用透明版本。
- Android、iOS 与网站继续使用**已选黑底成稿**（`new/astaria-icon.svg` 与上表对应的手机/Web 输出），手机保持黑底。
- 2026-10-17 已将这次批准的桌面透明转换固化到 `scripts/generate-icons.mjs` 默认流程；此前仅覆盖本机候选的方式已被取代。
- `new/astaria-icon-transparent-2048.png` 是 Git 忽略的本地素材，不要 `git add -f`，也不要修改忽略规则；
  它不进入仓库与分发产物，也没有被打进本地包；进入本地包的是导出后的透明 ICNS 与 ICO。
- 已通过：Mac 本机候选签名与隔离冒烟通过；ICNS 11 档、Windows EXE 与 NSIS setup 7 档资源的像素透明验证通过。
- 验收边界：**Finder 替身的透明图标与目标已在本机核对，Dock 刷新后由用户确认透明图标；Windows 真机尚未验收**。本节记录的是本地候选应用，
  不构成 Windows 设备显示验收或公开 Release。

## 已核对状态

2026-10-15 同版本本机候选替换后，Dock 曾继续显示旧黑底图标；包内ICNS与系统登记/替身图标已是透明版，源文件未回退。更新外层App目录修改时间、重新登记当前App、重载Dock并启动后，读取的当前运行实例图标透明度符合既定透明源，签名验证仍通过。打包器现会在最外层签名前更新App目录时间，避免继续继承Electron运行时的1980时间戳；同版本替换验收还须核对运行实例与Dock显示，不能仅比较ICNS和Finder替身。此修改不重绘图标、不改Bundle ID或用户数据，也未修改已生成安装包的内容哈希。

- `public/astaria-logo.svg` 与 `design/icon/new/astaria-icon.svg` 的 SHA-256 一致
  （`71859d61487913093ee6139726ca3b81246b799219e21f04dfce95dc0e20b49d`）。
- 11 种网页、iOS 与 Android 主图的 raw 像素与独立直接栅格化的黑底成稿逐像素一致。Mac App 中的 11 个 ICNS 规格和提醒辅助程序图标已核对。
- 逐项生成与验收状态记录在[候选验收状态](../../docs/releases/v1.0.0-rc.1-readiness.json)。
- 图标许可与来源见[资源说明](../../ASSET_PROVENANCE.md)。
