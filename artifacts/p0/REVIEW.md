# ASTaria P0 独立复核历史记录

> 本文保留中间复核时点的发现和测量；下文的“待刷新”、旧 trace 哈希、旧镜头参数与旧构建状态均为历史记录，不代表最终交付状态。最终证据见 [交付报告](./交付报告.md) 与 [修改清单](./change-manifest.json)。收尾核验已确认清单中13个源码/脚本哈希全部匹配；生产包包含删除外圈边界后的鼠标着色器。最终暂停帧差分见 [鼠标边界检查](./pointer-boundary-checks.json)：星空与吸积盘两处测试中，距指针110 CSS px以外的RGB通道差均为0。该结论仅针对这些截图，不替代所有场景的动态目视验收。

复核时点：2026-09-15 15:02 UTC，随后复读确认主代理的采样、Escape 与鼠标分支修复。此文件记录该时点的源码及实际证据；主代理正在刷新最终录制，后续文件覆盖后应重新核对 SHA-256 与数据。复核阶段仅写此报告，没有修改实现。

## 结论与交付前事项

目前源码已具备 P0 黑洞、同一材质昼夜变化、真实 Schwarzschild 弯曲光路、差速纹理相位、视向多普勒、两套观测镜头、粒子与鼠标局部透镜。业务文件哈希保持一致。数值几何检查可信，浏览器记录也有真实合成器及呈现反馈事件。

**本复核不将整个 P0 宣布为全部验收通过。** 当前最高档新录制出现若干长帧，最终安全档录制及汇总仍在更新；旧视频没有在本次复核中完整观看；最新版白昼材质与镜头的截图、录像和检查结果需要最终刷新。

已向主代理报告并复读确认修复的两个小范围问题：

1. 原帧样本数组限长18,000后，“记录10秒”导出零样本。现在使用开始/结束的单调帧计数差取尾部样本，连续运行场景不再依赖数组长度增长。复核未额外覆盖采样过程中用户切到后台/暂停/改变档位的混合场景；帧计数含交互单帧，严格测量应保持期间状态稳定。
2. Escape 现在先于 INPUT/SELECT 排除分支处理，焦点位于滑条时也能关闭观测台。旧的后置 Escape 分支仍冗余存在，但不会再次执行。

主代理另定位到鼠标外圈来自220px处的提前返回分支，并删除整个分支。复读确认现为全画面连续Gaussian计算；最终截图差分与性能录制仍待更新。复读后没有发现默认连续运行路径上新的必修实现问题；剩余重点是如实完成最终证据对应。

## 范围与哈希

对 `baseline-hashes.json` 中 **26 个原有文件**逐一计算 SHA-256：22 个相同、4 个改变、0 个缺失。改变的是 `index.html`、`src/main.tsx`、`src/prototype/BlackHolePrototype.tsx`、`src/prototype/prototype.css`。`src/App.tsx`、全部 `src/domain/`、`src/stores/`、`src/services/` 以及 package、lockfile、Vite、TS 配置均与基线相同。业务文件仅做哈希核对，未读取私密内容。

`src/main.tsx` 默认进入 P0，直接以 `#/app` 加载仍可进入原应用。该入口只在启动时选择组件，不是一个处理 `hashchange` 的完整路由器。

另观察到新增图标文件 `public/apple-touch-icon.png`、`public/astaria-app-icon.png`、`public/favicon-16x16.png`、`public/favicon-32x32.png`、`public/favicon-48x48.png`、`public/favicon.ico`，以及本文下表中的新增原型与验证脚本。主代理说明没有修改 `index.html`，故这里把该文件与图标变化记录为当前目录的外部/并发差异，不归功于本次黑洞实现；旧哈希不能证明是谁或何时修改。基线是有限文件清单，不能把它表述为完整文件系统审计，也不能仅凭哈希证明没有发生过推送或部署。

三份 `before/` 原始文本的哈希均与记录的基线吻合，以下差分是实际 `diff -u` 统计，不是估算：

| 原有文件 | 修改前行数 | 复核时行数 | 增加 | 删除 |
|---|---:|---:|---:|---:|
| `src/prototype/BlackHolePrototype.tsx` | 9 | 141 | 137 | 5 |
| `src/main.tsx` | 19 | 20 | 2 | 1 |
| `src/prototype/prototype.css` | 3 | 9 | 9 | 3 |

`index.html` 只有旧哈希，没有旧文本快照，因此不提供其增加/删除行数。CSS 源码沿用压缩式长行，物理行数不代表改动复杂度。

| 基线中不存在的代码文件 | 复核时行数 |
|---|---:|
| `src/prototype/BlackHoleRenderer.ts` | 757 |
| `src/prototype/StarInfall.ts` | 319 |
| `src/prototype/postprocessing.ts` | 200 |
| `src/prototype/geodesics.ts` | 185 |
| `src/prototype/shaders.ts` | 221 |
| `scripts/capture-p0.mjs` | 138 |
| `scripts/verify-geodesics.mjs` | 217 |
| `scripts/summarize-trace.mjs` | 808 |
| `scripts/summarize-trace.test.mjs` | 759 |
| `scripts/summarize-presentation.mjs` | 237 |

关键源码 SHA-256：

```text
src/prototype/shaders.ts d8894ae6dd67bd2de442f78c78a4965a99a8bfe273f7f6d5af869cb65fdb191e
src/prototype/BlackHoleRenderer.ts 3bb8225e5e3edc0d85b8db5ec63e0a99b22d0a9d1f88df3890552771085bcbb3
src/prototype/BlackHolePrototype.tsx cbdfacd9bd24044f0aa83526623821c05c145789725d6747ae90eac2cc385fb2
src/prototype/postprocessing.ts 017067deb464c5b55d45058a2bc5518ce761846d3285622af4911ac8528e0296
scripts/verify-geodesics.mjs b8a39f50ed7efeb1cf0d7a0389eb31fc4baf059c7f6f3e3d76c232c9cf89e29a
```

## 当前要求与源码对应

| 检查项 | 复核结果与限制 |
|---|---|
| 默认全景 | zoom 0.7、倾角 83°、roll 18°、中心 (0.65, 0.51)，UI 初值和 renderer 初值一致。 |
| 星际镜头 | zoom 2.05、倾角 84°、roll 7°、中心 (0.98, 0.51)，使用可中断临界阻尼过渡。旧 `camera-checks.json` 的 roll 18° 是旧镜头证据，不能证明当前 7° 设置。 |
| 用户回退流动强化 | `radialWarp` 为 `.09*turbulence`，broad/mid 使用 `orbit*.28` / `orbit*.44`；没有强化版额外相位正弦和 current 密度乘子。时间系数保留 1.9，未加速。 |
| A1 差速 | `phase=atan(z,x)-time*1.9/r^1.5`，再以 sin/cos 周期坐标采样，避免 atan 接缝。r=3 与 r=6 的角速度比为 2.828427。源码成立不等同于已完成 400px、30秒目视验收。 |
| A2 多普勒 | 空间速度方向与本地弯曲光线决定 boost，未使用纹理 advected phase 决定亮侧。旧白昼输出丢弃 ink 的问题已修为 `dayColor=color`，此修复仍需新版图像对比。两侧屏幕亮度 2–5 倍尚无本复核独立像素测量。 |
| A3 透镜 | LUT 解 `u''+u=1.5u²`，最多三个实际盘面交点；背景强透镜区域按逃逸光线方向采样。远场为保留星点锐度混合平面星图，属于视觉近似。 |
| A4 光子环/圆周 AA | 阴影用解析临界冲量与 `fwidth` 抗锯齿；细环具有独立亚像素尺度与指数衰减肩部。已查看静态图可见细环，但没有以静态图证明动态边缘完全无闪烁。 |
| A5 纸边 | 白昼 capture 边缘有两个角向噪声频段扰动，幅度极细。查看旧白昼图可见细微纸边，但该图并非新的昼间多普勒修复证据。 |
| 星野与粒子 | 确定性 50,000 星 catalogue，初始化/尺寸或档位变化时一次 Points draw 写入星图；日常帧无需重画 catalogue。10 个常驻流入星尘，每个30点；用户触发粒子独立绘制。粒子是满足加速规律的屏幕空间轨迹，不是粒子时空测地线求解。 |
| 鼠标微型黑洞 | CSS像素尺度，Gaussian `exp(-r²/1152)` 局部透镜衰减，无人为外边缘描线；约4px暗核、4.7px细光子环和短程 halo。220px早退出分支已删除，现为连续全画面计算。已查看旧 `pointer-disc.png`；无外圈修复仍需最终截图差分。 |
| P4 后台停止 | `visibilitychange` 立即 cancel rAF、清测量时钟、停 stats timer；再次可见按需恢复。旧 camera JSON 有实际隐藏标签页前后 renderedFrames 不变证据。 |
| reduced-motion | 暂停环境循环，镜头/昼夜/鼠标立即到位，必要交互仍请求单帧；粒子保留简化静态结果。未做全局一刀切 CSS 禁动画。 |
| 资源生命周期 | dispose 取消 rAF/timer、移除 listeners、释放 render targets/material/geometry/纹理；上下文丢失有取消与恢复处理。没有独立强制 context-loss 实测证据。 |

黑洞光路使用非旋转 Schwarzschild 模型；吸积盘 emissivity、速度幅值 beta、光子环与 tone mapping 有艺术化参数。未实现 Kerr 自旋/拖曳、流体动力学或完整相对论辐射传输，因此不能把本原型称为全部物理过程精确模拟。实现符合“用 shader 表现可信运动”的 P0 范围。

## 数值验证（本次实际重跑）

命令：

```sh
/usr/local/bin/node scripts/verify-geodesics.mjs
```

实际使用 `{cameraRadius:30,maxImpact:24,width:1536,height:1024}`，已与生产 LUT 参数一致；对照网格 3072×2048。6组断言全部通过，303.503292ms。部分原始输出：

```json
{"check":"horizon_capture_and_escape","invalidTexels":0,"classificationMismatches":0,"capturedColumns":768,"escapedColumns":768,"unterminatedRays":0,"maxTurningPolynomialResidual":0.0000011647948362300264,"maxReportedFirstIntegralRelativeError":9.197161418375005e-13}
{"check":"serialized_first_integral","samples":18902,"maxRelativeError":0.000051438092443234495,"tolerance":0.001}
{"check":"independent_terminal_quadrature","maxAbsoluteErrorRadians":0.000237981402335663,"toleranceRadians":0.003}
{"check":"double_resolution_convergence","impactCases":20,"closestCriticalDistance":0.000001,"emittingSamples":993,"maxInverseRadiusDifference":0.00020858404769249356,"maxEmittingRadiusRelativeDifference":0.00003499667860473732,"tolerance":0.001}
{"check":"inclined_disk_intersections","inclinationDegrees":78,"grid":[121,81],"validCrossings":6632,"secondaryCrossings":567,"maxPlaneResidual":6.001386146657647e-15}
{"check":"result","status":"PASS","checks":6,"durationMs":303.50329200000004}
```

独立终止角验证使用第一积分的 Simpson 积分，算法不同于 LUT 生成器的 RK4，因此不是简单复写实现。纹理有限差分另核对 Float32 序列的守恒量。测试的盘面倾角78°是一般几何检查；两个最终镜头还应依浏览器检查与图像验收。

复核时磁盘上的 `geodesic-checks.txt` 仍是 maxImpact20 的旧输出。最终交付应以最新命令重新保存，不应把旧原始日志标签改成24。

## 性能证据及明确边界

真实 trace 具有 `DrawFrame` 的 I 事件、`AnimationFrame::Presentation` 的 n 事件、`PipelineReporter` 的 b/e 事件。分析器按线程/进程/活动 layer 与 frame sequence 分组，不跨线程混合；对每个 frame 的 ALL 与 FORKED/PARTIAL 双报告去重，排除旧 layer 缓存事件，并明确记录捕获末尾未完成反馈。

复核时最新 Ultra 文件和仍未覆盖的旧 Safe 文件：

| trace | SHA-256 | 浏览器呈现标记 | 呈现反馈频率 | P95 / max | >20ms / >33.34ms | 内部序号缺口 |
|---|---|---:|---:|---|---|---:|
| `trace-ultra-retina.json.gz` | `2f5e6c39545506b83b281ca1cea5aca959a41404edcb7ce70599e1b308a71301` | 594 | 59.596223Hz | 17.2286 / 62.078ms | 5 / 3 | 3 |
| `trace-safe.json.gz`（旧） | `0d368af757221db512edd9842b25d6d35863ef201cf1cfeb30e0944441fc7abc` | 599 | 60.005441Hz | 17.45475 / 18.051ms | 0 / 0 | 0 |

最新 Ultra DrawFrame 为597个，59.698377Hz，最大间隔40.611ms。其 scoped pipeline 无显式 DROPPED 状态、无只有 PARTIAL 而没有 ALL 的组，但这不抵消实际呈现间隔的停顿或序号缺口。3个末尾 DrawFrame 尚无完整 reporter，是捕获边界未知值，不能视为已呈现或已丢帧。

前一版 Ultra 的59.998108Hz、0个>20ms数据只属于旧 SHA `fbd21634c29d93cc1baf7c0a43c380d999ffc5352dd9f450259d57ba0079d2ee`，不可移植给新录制。复核时 `presentation-summary.json` 尚未跟随新的 Ultra 刷新。

重现命令：

```sh
node scripts/summarize-presentation.mjs artifacts/p0/trace-ultra-retina.json.gz artifacts/p0/trace-safe.json.gz --capture-mode headless --out artifacts/p0/presentation-summary.json
node scripts/summarize-trace.mjs artifacts/p0/trace-ultra-retina.json.gz artifacts/p0/trace-ultra-retina-summary.json
node scripts/summarize-trace.mjs artifacts/p0/trace-safe.json.gz artifacts/p0/trace-safe-summary.json
node --test scripts/summarize-trace.test.mjs
```

汇总器测试上一轮独立运行是29 passed、0 failed；包括现代 task aliases、B/E 配对、线程隔离、metadata时间戳、压缩文件、原文件与链接保护。呈现汇总器另做了重复时间戳、复用 async id、显式 dropped 与 forked partial、历史 reporter 排除的构造检查。

**上述 trace 来自 headless Chrome。它能证明浏览器内部合成及呈现反馈 cadence，不证明物理显示器真正完成扫描输出，也不能替代明确要求的原生 DevTools Performance 面板录制上下文。** 当前新 Ultra 有长帧，不能宣称“所有档位严格稳定60fps”；Safe 的≥50fps也应以最终版本重新录制为准。

## 视觉与其他证据状态

本次实际查看了 `screenshots/night-1440.png`、`day-1440.png`、`night-390.png`、`pointer-disc.png`。这些截图可确认黑色阴影、跨越前方的盘面、上方弯曲背盘、较弱下方像、细环、移动端构图和鼠标局部扭曲；不能凭截图判断30秒差速动感、连续运动抖动或切换中的色阶。

`black-hole-30s.webm` 存在，9,940,970字节，mtime为2026-09-15 14:49:33.895 UTC。源码显示通过 canvas.captureStream(30) 与 MediaRecorder 录制；本次没有解码并完整观看，不声称其实际时长、30秒无破绽或与最终 source一致。

`browser-checks.json` 上一轮6项均为true，包含暂停、390px、reduced-motion交互、最低档、无运行异常。`camera-checks.json` 的隐藏标签页验证与过渡连续性有数据，但其星际roll18°已过时。`pointer-checks.json` 的暂停后鼠标退出静止检查为true、帧计数稳定。本次没有把这些旧结果当作最终源码每一处的重新验证。

`build-output.txt` 上次构建显示 TypeScript+Vite 成功，并保留923.63kB压缩前主bundle警告；该日志早于最后的部分更改，最终仍需运行构建并保存真实输出。该文件大小提示属于初次载入/拆包限制，不等同于GPU帧率失败。

最终报告应替换以上“待刷新”数据，附最新 source/trace 对应关系，保留 headless 与视频未观看等边界；不要把验证工具的自报 PASS 或文件存在直接替换成人眼、原生面板或显示器验证。
