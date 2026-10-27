# ASTaria 图标源与导出

## 图标源

- `new/astaria-icon.svg`：各端黑底成稿主源，`viewBox="0 0 1600 1600"`，银灰三瓣配 `#282828` 底。macOS 27 会将透明应用图标合成为浅灰 Liquid Glass 底，因此桌面端采用黑底成稿以保持既定外观。
- `new/astaria-icon-transparent.svg`：同一几何的透明源，仅用于 Android adaptive 前景、通知与主题遮罩、启动画面合成。
- `new/astaria-icon-transparent-2048.png`：历史透明桌面素材，为 Git 忽略的本地文件；当前导出流程不依赖它。
- `old/`：历史资料，不作为生成源。两个 SVG 主源只差背景矩形，保持只读，不重绘、不改银灰色阶。

## 可重复导出

```bash
node scripts/generate-icons.mjs --sharp /absolute/path/to/sharp/dist/index.mjs
```

- 使用本机已安装的 Sharp；脚本不安装依赖、不访问网络。
- `--source`（透明源）与 `--opaque-source`（黑底源）可指定源 SVG，默认指向 `design/icon/new/`。
- `--out`、`--android-res`、`--ios-assets` 可改到隔离输出目录，省略时使用脚本内置的 `public/`、Android 资源与 iOS Assets 目录。
- 桌面 PNG/ICO 与手机/Web 图标均从黑底源按完整 viewBox 直接栅格化，不再放大透明 PNG 母版。
- 脚本先完成全部源文件解析、Android 矢量转换与栅格化，再写出 41 项资源；输入只读，输出不覆盖输入。两个 SVG 主源除背景矩形外必须一致，否则导出失败。

## 输出

| 输出 | 内容与用途 |
| --- | --- |
| `public/astaria-logo.svg` | 黑底源逐字节复制 |
| `public/astaria-logo.png`、`public/astaria-icon-1024.png` | 同一黑底源，1024 像素 RGB，无 alpha；后者用于生成 macOS App 与提醒辅助程序的 ICNS |
| `public/favicon.png`、`public/apple-touch-icon.png`、`public/pwa-192x192.png`、`public/pwa-512x512.png` | 黑底主源完整 viewBox，RGB |
| `public/maskable-512x512.png` | 图案占画布 78%，完整轮廓位于 80% 安全圈内，黑底 |
| `public/astaria.ico` | 16/24/32/48/64/128/256 七档，保留 NSIS 所需的 RGBA 容器，所有像素 alpha 为 255 |
| `mipmap-*/ic_launcher.png`、`ic_launcher_round.png` | Android 传统 launcher 黑底方图；round 只按圆形裁切 alpha |
| `mipmap-*/ic_launcher_foreground.png` | Android adaptive 前景，图案占 108dp 画布的 60/108 |
| `drawable-*/ic_launcher_monochrome.png`、`ic_stat_astaria.png` | Android 主题单色与状态栏通知：原 alpha 配白色 RGB |
| `drawable/astaria_splash_icon.xml` | Android 12+ 启动图标矢量，启动主题提供黑底 |
| `values/ic_launcher_background.xml`、`values/colors.xml` | `#282828` 黑底资源 |
| `AppIcon.appiconset/AppIcon-512@2x.png` | iOS App 图标，1024 像素 RGB，无 alpha |
| `Splash.imageset/splash-2732x2732*.png` | iOS 启动图，黑底与 24% 居中图案 |

macOS 打包器默认读取 `public/astaria-icon-1024.png` 生成 App 与提醒辅助程序的 ICNS；Windows 打包器默认读取 `public/astaria.ico` 生成 EXE 与 NSIS 安装/卸载图标。正常打包沿用这两个默认输入。

## 验收

```bash
node --test scripts/mobile-native-icons.test.mjs scripts/nsis-icon.test.mjs scripts/windows-branding.test.mjs
```

- 测试独立解析 SVG 几何和色阶，核对桌面 PNG/ICO 的黑底四角、全不透明像素、轮廓及银灰色阶；NSIS 转换逐像素核对 RGB/alpha。
- 保留手机/Web 安全圈、通知遮罩和 iOS 无 alpha 检查。
- macOS 打包后必须通过 `codesign --verify --deep --strict`；不能给已签名的 App 写 Finder 自定义图标元数据，否则会破坏签名。
- 同版本替换后仍需核对运行实例与 Finder/Dock 的实际显示，仅比较包内 ICNS 与快捷方式不足；包内资源检查不能替代系统合成结果。

图标资源来源与分发范围见[资源来源说明](../../ASSET_PROVENANCE.md)。
