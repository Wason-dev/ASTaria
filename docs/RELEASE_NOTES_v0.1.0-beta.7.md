# ASTaria 0.1.0-beta.7

这是一次面向更新体验的小版本，适用于 macOS 13+、Apple Silicon（arm64）。安装包仍采用 ad-hoc 签名，尚未 Apple 公证。

## 本次改动

- **下载进度**：设置里的更新进度条改用 ASTaria 的玻璃、低饱和金色与中性灰样式，不再使用系统绿色进度条。显示宽度来自真实下载字节数，下载轮询时平滑过渡；开启“减少动态效果”后直接更新。
- **自动安装位置**：正常放在 `/Applications/ASTaria.app` 的 App 可以继续自动更新。更新器会保留对 DMG 挂载卷、App Translocation、应用包符号链接、只读父目录和不可写 App 包的拦截，并给出具体原因。
- **回归保护**：补充父目录别名和 App Translocation 场景，覆盖更新包身份、清单签名、下载校验和原子替换链路。

## 验证

- `npm run typecheck`
- `npm test`
- 更新专项：下载、更新服务、安装器和发布信任测试
- `git diff --check`

## 已知边界

长期计划自适应重排、按需联网搜索、更多模型执行阶段展示和 Windows 安装包仍是后续规划，不属于本次 beta.7 发布范围。更新安装仍要求 App 已从 DMG 移到可写的正式位置，并且本版没有 Apple 公证。
