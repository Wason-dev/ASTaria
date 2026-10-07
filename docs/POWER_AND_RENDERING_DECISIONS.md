# 省电与渲染决策记录

本文记录需要在后续版本和交接中保留的产品约束。性能数字、测试环境与历代优化记录见 [PERFORMANCE.md](./PERFORMANCE.md)，视觉要求见 [UI_DESIGN_SYSTEM.md](./UI_DESIGN_SYSTEM.md)。修复卡顿前应先核对这里的策略，不能只看到帧率较低就判定为 bug。

核对日期：2026-10-06，Beta11 本地体验完善阶段。证据分为用户明确确认、历史提交/文档和当前源码；源码能证明当前行为，不能单独证明最初设计动机或实际节省了多少电量。

## P01 · 工作区的环境渲染最高 60 FPS

**状态：保留。原因：省电；用户于 2026-10-05 明确确认。** `3b47f23`（beta.1）已包含这一上限，`615e09f`（BetaX）继续保留。并非 Beta11 新增限制。

| 手动选择 | 首页与首页聊天 | 工作台、日程、余时等非首页工作区 | 返回首页 |
| --- | ---: | ---: | ---: |
| 30 FPS | 30 | 30 | 30 |
| 45 FPS | 45 | 45 | 45 |
| 60 FPS | 60 | 60 | 60 |
| 90 FPS | 90 | 60 | 90 |
| 120 FPS | 120 | 60 | 120 |

- 这是黑洞/环境渲染的目标预算；不等于给全部 DOM、CSS 动画、输入事件或显示器施加统一锁帧。实际帧率仍受屏幕、GPU、系统和负载限制。
- 依据当前页面选择预算，不检测电池余量或是否插电；接电时也保留工作区上限。不能擅自改成仅电池模式生效。
- 切页不改写保存的帧率选择，不将 30/45 提高到 60，不因此降低独立选定的手动画质。
- 当前页面映射在 `src/home/HomeWorkspace.tsx` 的 `onRenderProfile` effect；上限在 `src/prototype/renderProfile.ts::resolveRenderProfile`；切换在 `BlackHoleRenderer.ts::setRenderProfile`。
- 验证：`scripts/render-profile.test.mjs`、`scripts/renderer-profile-switch.test.mjs`、`scripts/verify-response-settings.mjs --render-policy-only`；原生交互诊断同时核对选定档位和有效 `targetFps`。

Beta11 本地提交 `ba3ec80` 曾误将取消上限写作优化；已按用户说明撤销这一改动。该中间构建不能作为最终安装包，工作区解除上限取得的数字不得写入性能收益。真正需要修复的是目标预算内的误跳帧、长帧、无用工作与切页停顿。

## P02 · 页面隐藏时停止可视渲染，返回时恢复

**状态：保留；当前代码行为已核对。** 黑洞在 `document.hidden` 时取消 RAF、暂停环境时钟与统计定时器；恢复时重新测量并请求一帧。超过 1 秒的系统遮挡/挂起间隔不计作连续慢帧，不用它快进场景或触发错误降质。上下文丢失、销毁时也不继续调度。

弦轨、轨道、弦线和组详情分别在各自 visibility handler 里停止隐藏页动画。不能笼统把窗口失焦等同于不可见：仍可见的窗口需要正常呈现；各平台的系统遮挡节流可能不同。

依据：`src/prototype/BlackHoleRenderer.ts::{handleVisibility,handleForeground,frame,requestFrame}`，`src/xixi/{horizonScene,orbitScene,stringCanvas}.ts`，`src/xixi/HorizonGroupDetail.tsx`。beta.3 的后台优化已记在 `PERFORMANCE.md`；各机制首次引入的完整动机未逐项恢复，不补写为历史事实。弦轨隐藏/恢复/销毁覆盖见 `scripts/horizon-renderer.test.mjs`。

## P03 · 暂停、减少动态效果与遮盖状态按需绘制

**状态：保留；目的包括减少无意义绘制与尊重动态效果偏好。** 环境停止后，必要的主题变化、相机/指针收尾、回应与外部转场仍可请求实际 GPU 帧；静止后不持续空转。减少动态效果不是禁用操作反馈。

中央穿越完成、首页黑洞完全被遮住时停止其绘制；边缘弦轨到达仍露出黑洞，必须继续保持背景和时间连续。不能把这两个模式一并停掉。

依据：`BlackHoleRenderer.ts::{ambientIsRunning,stringFlightIsCovered,handleStringFlight,frame}`；`scripts/decision-effect.test.mjs`、`scripts/horizon-renderer.test.mjs`。这是状态约束，不是允许任意缩短既有转场。

## P04 · 隐藏时停止 UI 轮询，返回立即刷新

**状态：保留；beta.3 已记录减少后台 JavaScript、网络轮询与分配。** `startVisiblePolling` 在隐藏时清掉 interval，恢复时先刷新再恢复原频率；设置共享订阅合并读取，内容相同的快照不重复发布，没有订阅者不继续轮询。首页时钟按分钟边界更新，隐藏时停止，恢复或重新聚焦时校准。

依据：`src/stores/visiblePolling.ts`、`src/xixi/preferencesStore.ts`、`src/home/useLocalTime.ts`。检查：`scripts/idle-snapshots.test.mjs`、`scripts/preferences-store.test.mjs`、`scripts/verify-idle-performance.mjs`。

这只描述这些可视 UI 消费者，不能推断后台同步、正在执行的请求或所有业务服务都被暂停。新的后台机制须单独说明生命周期和必要性。

## P05 · 专注计时保留真实时间，减少 UI 唤醒

**状态：保留；beta.3 优化及当前源码可核对。** 未开始、暂停或完成时没有周期唤醒；可见且运行中保留 250ms UI 更新；隐藏或工作台不活跃时只等待本轮到期，返回立即按真实经过时间校准并保存必要检查点。隐藏窗口不会暂停正在进行的专注，也不会自动开始休息或下一轮。

依据：`src/workbench/{focusTimerTicker,useFocusTimer,focusTimer}.ts`；`scripts/focus-timer-ticker.test.mjs` 覆盖隐藏到期、系统挂起、返回、清理和 StrictMode。不能为追求零定时器而丢失到期语义。

## P06 · 画质、帧率与 Windows 玻璃取舍分别记录

**状态：保留。** ASTaria 推荐以 60 FPS、最高画质起步；只有持续负载才逐档调整，稳定后尝试恢复。相机/日夜转场不作为持续降质依据；恢复失败有退避，避免反复升降。手动画质不走自动降档。这是已有自适应取舍，不能算作 Beta11 同画质收益。

Windows 默认 CSS 玻璃省去 SVG 精细边缘位移，保留通透/磨砂差异、色调、边缘和反光；可手动选精细折射。**这是 BetaX 已有的材质取舍，不是无损优化。** 不改变黑洞各画质档位定义。macOS 的默认折射路径仍按能力选择。

依据：`src/prototype/adaptiveQuality.ts`、`BlackHoleRenderer.ts::adaptQuality`、`src/home/glassRendering.ts`；`scripts/adaptive-quality.test.mjs` 及 `PERFORMANCE.md` 中 BetaX 的同机对照。WebGL 的 `powerPreference: high-performance` 是设备选择提示，不是强制独显或永不省电的保证。

## P07 · 不可见材质与相同结果不重复计算

**状态：保留已有材质生命周期；Beta11 补充同质量去重。** 不活动的页面通过 `GlassSamplingContext` 停止不需要的采样。Beta11 保留同预算切页的帧调度和自适应历史；相同相机几何、SVG 属性、逐字节相同的位移图不重复更新。CSS 玻璃不建立无用 SVG/几何观察器。工作台、日程、余时保留 DOM，在既有退出淡出结束后跳过隐藏布局；返回恢复显示、编辑状态和滚动位置。

浅色准确端点的 bloom 贡献为零才跳过中间 pass；首次非零贡献立刻恢复。指针强度精确为零才跳过无贡献的指针效果计算。不能扩大阈值来偷减可见细节。

依据：`src/home/{GlassSurface,glass,glassRendering,retained-pages.css}`、`src/spatial/useSceneCamera.ts`、`src/prototype/postprocessing.ts`；`scripts/{beta11-motion,glass-displacement,bloom-passes,renderer-profile-switch}.test.mjs` 和 `desktop/{render-equivalence,interaction-visuals}.mjs`。原生像素/动态验收结果见性能记录；CSS 合成边缘存在取整差异，不能把整套 UI 宣称为逐像素相同。

## P08 · 交互就绪不等待相机弹簧完全停稳

**状态：Beta11 修复；共享于 macOS 与 Windows，原生验证按平台分别记录。** 首页聊天保留原有展开进度 `0.99` 的可输入阈值和收拢进度 `0.01` 的入口焦点阈值。相机弹簧可以继续完成原轨迹，输入与焦点不再额外等待 `cameraTransition=false`。此前 imperative 相机消费者只在转场开始/结束发布 React 状态，导致 DOM 的 inert 比真实几何滞后；焦点 effect 还独立等待完全停稳。2026-10-06 的 Mac 对照确认约 1.1 秒额外等待，详见性能记录。

`useSceneCamera` 只在收拢、转场、可输入三个阶段边界补充发布，保持逐帧几何更新与重复快照去重；没有阶段 key 的旧消费者行为不变。动画轨迹、弹簧时长、画质、材质与帧率预算均不修改。提前恢复的控件仍受页面、展开状态和窄屏面板的 inert 限制，切页后不能把焦点抢回隐藏聊天。

依据：`src/home/chatMotion.ts`、`src/home/HomeWorkspace.tsx`、`src/spatial/useSceneCamera.ts`；`scripts/chat-camera-publication.test.mjs` 覆盖阶段发布、反向、去重、隐藏恢复和旧消费者。Mac 原生 20 项动态矩阵与独立六组输入检查覆盖真实 inert/焦点、反转、草稿、切页及系统减少动态；摘要见 [beta11-chat-readiness-mac.json](./performance/beta11-chat-readiness-mac.json)。系统偏好通过 CDP 模拟并核对 renderer 的 `reducedMotion=true`、无相机转场，不能只用应用内「析熙的回应」动态偏好代替。该修复处理响应延迟，不证明 Windows 渲染长帧已解决，也不产生已量测的功耗收益。

## 修改与交接要求

每次改变上述策略或新增策略，应记录：触发条件、适用平台/页面、设计原因及其证据、画质或响应性代价、保留的业务语义、回归检查、实际验收与未完成项。本文记录当前约束；`CHANGELOG.md` 和各版 release notes 保留版本历史；`PERFORMANCE.md` 保留测量条件与收益限制。不要用新说明覆盖掉历史。

测试目标是同画质、同有效帧率预算和可比较负载下减少浪费。当前没有系统功耗、温度或续航的完整实机量测，也没有已验证的电池百分比/插电自动切换策略；不能由帧率测试编造省电百分比。后续发现未记录的老策略时，先查实现、提交和既有用户决定，再决定是否更改。
