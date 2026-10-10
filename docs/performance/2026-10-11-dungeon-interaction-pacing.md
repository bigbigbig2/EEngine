---
id: performance/dungeon-interaction-pacing-2026-10-11
state: current
verifies:
  files:
    - OEngine/src/camera/OrbitControls.ts
    - OEngine/src/render/FrameCoordinator.ts
    - OEngine/src/render/pipeline/RendererCore.ts
    - examples/demos/14-integrated/dungeon-warkarma-texture-compression/main.ts
    - examples/demos/14-integrated/dungeon-warkarma-texture-compression/index.html
    - examples/demos/14-integrated/dungeon-warkarma-texture-compression/frame-pacing.ts
    - examples/demos/14-integrated/dungeon-warkarma-texture-compression/texture-quality.ts
    - OEngine/tests/unit/orbit-controls.test.mjs
    - OEngine/tests/contract/renderer-submission-count.test.mjs
    - examples/tests/dungeon-frame-pacing.test.mjs
---

# Dungeon 交互帧节奏与相机时间

起始 HEAD `1ddfb637`。Before 使用 [2026-10-10 报告](2026-10-10-dungeon-warkarma-performance-report.md)，没有重复 baseline。本单元修复 CPU 交互节奏，不修改 GPU shading、VSM、FSR、Geometry Streaming、分辨率或容量。原始失败、headed smoke、截图、两段 CPU profile、sourcemap 和 build fingerprint 保存在 `.local/validation/dungeon-interaction-pacing-2026-10-11/`，不提交。

【源码事实】原 RAF/ready 都进入 draw，每次推进 controls，且 defer 也推进 callback 时间。enableDamping 按调用次数消耗残量，host 又调用 camera.update，pointermove 查询 bounding rect 并分配对象，snapshot 每次重新编译 material graph。详细面板原已标 Submitted FPS；快捷栏仍标 FPS。另发现 Renderer 的两个 catch 即使编码未提交也增加 frame_count。

现在 input events 只积累残量；RAF → controls.update(interactionDelta) → finalize camera → render attempt。默认 interactive 的 completion wakeup 等下次 RAF，`performanceCapture=1` 的 max-throughput wakeup 只重试已经确定的相机状态。FrameCoordinator 的在途限制、fence、退休次序及唯一提交入口保留，ready 通知没有循环 timer。frame_count 仅在真实提交时增加；提交后的 publication 失败仍计数一次，错误继续传播。

Interaction clock 与 admitted frame 的采样时间 clock 独立。defer 不改变后者，下一次提交 delta 包含全部未提交间隔，仍 clamp 到 [0, 0.1] 秒。使用 callback 执行时的 performance.now，避免延迟 RAF 的显示时间戳早于先执行的 ready。初始/恢复 tick 为 1/60 秒；pause/visibility 是显式时间断点，single-step 为 1/60 秒，被 defer 后不重放 interaction。普通运动不新增 temporal reset；pause、显式 camera cut 的原有 reset 保留。

旋转/pan 残量按 `(1-factor)^(dt*60)` 衰减，60 Hz 消耗比例与原 dampingFactor 相同。Dolly 在乘法域插值/衰减，保持 wheel/dolly 输入倍率及方向，使相同脉冲在相同真实时间消耗相同总倍率；阻尼缩放从旧线性倍率插值变为指数插值，普通小 wheel 步接近原手感，大倍率不承诺逐 tick 数值等同旧实现。无阻尼倍率不变。此时间一致性指相同输入脉冲，不宣称不同采样时刻的连续输入轨迹完全相等。

Host 删除重复 camera.update；GPUCameraState.update 仍防御性更新 camera，这是其他 renderer caller 的现存契约。Pointer delta 用 client coordinates，height 在构造/ResizeObserver/host resize 更新。复用 offset scratch，删除每 tick 的 position clone、targetOffset、offset 分配；pointermove 就地更新记录，touch 不复制整张 pointer Map。

Texture quality 使用 GpuRenderWorldRuntime.appearancePrograms 的已发布样本。GpuMaterialStore 发布冻结程序数组，GpuRenderWorld 创建冻结 runtime，TextureProduct 元数据不可变；缓存按 runtime identity，append/resync/material replacement 发布新 runtime 即失效，release 清空。未发布 authored topology 编辑不冒充 GPU 已消费的质量事实。MASK 的 live 分类检查仍读取当前材质；不修改生产材质编译/发布 owner。

成本卡：删除额外 ready simulation、host 矩阵/视锥计算、pointermove layout query、对象分配、每 500ms 的重复编译和遍历。新增每 interaction tick 少量 pow/标量时钟运算、一个 Vec3 scratch、一个 resize observer；一个 runtime 的静态 quality summary 常驻。无 GPU bytes/ALU/samples/atomics/barriers/pass/dispatch/submit 改变，无 GPU→CPU→GPU 控制。缓存命中无重编译；全部 republication 时重新扫描一次已编译 samples，无跨历史缓存。0% 命中时没有材质编译税，50%/100% 命中分别避开一半/全部静态统计扫描。帧节奏本身不承诺 FPS 收益：GPU 比显示慢时，interactive 等 RAF 可能减少 submission throughput，代价是 display-paced admission；capture 保留及时喂 GPU。GPU command cost 的理论节省为零。

【实测事实】engine/Dungeon typecheck、build、新鲜 build:test 和 25 个 targeted tests 通过，覆盖 rotate/right pan/wheel/touch/reset/external camera、30/60/90/120/144Hz 脉冲阻尼、defer/ready/delta、step/hidden/dispose、失败提交与 temporal transactions。早期失败属于 TS 参数类型/Node strip-only 语法、Node 宿主缺 WebGPU 常量，以及测试误认为 ChangeSignal 会抛 handler 异常；已修正测试宿主/预期，原日志保留，没有放宽生产断言。

真实 headed Chrome 154，1920×1080 internal/output、renderScale=1，串行执行 VSM+FSR ON/OFF 两组 rotate/pan/wheel/静止→运动→静止、pause/step/release。无 console error/device lost，只有 Windows 忽略 powerPreference 的已知 warning；释放 texture owner 达零。ON 组 color invalidation 保持 3，FSR generation 保持 1。静态质量维持 24 Products/25 texture leaves。截图无明显几何/材质异常；没有逐像素画质验收。

ON 交互窗口 n=455，RAF interval P50/P95 13.875/18.170ms，interaction CPU 0.065/0.145ms，ready 提交为零（552 interaction ticks、190 wakeups、351 submissions 为累计数，不是同一统计窗口）。这是完整场景交互 smoke，非固定近景 performance 对照，不能与 Before FPS 比较或证明输入到呈现延迟下降。之后固定标准近景 max-throughput smoke，仍发生 ready 提交，相机不变；未重新测量 coverage。OFF 仅验证开关生命周期，不计为同画质收益。

两段约 6.8 秒 CPU profile 经该 build sourcemap 还原：demo snapshot inclusive 37.275/22.777ms，没有采到 CanonicalMaterial 编译路径。旧报告 6.28 秒 snapshot 206ms/material 查询编译175ms，仅作热点参照；相机/功能/采样条件不同，不计算提升百分比。稳定阶段没有记录到 ≥50ms long task；短窗口不能证明以后不会有长任务。CPU 面板现在明确 render-only，interaction 单独采样，异步反馈/DOM/驱动成本仍不包含其中。

【待验证】真实 presented count/输入到光子延迟、较长交互轨迹、不同显示刷新率的实际手感未测。浏览器切 tab 没有产生 hidden 状态，真实后台恢复未验收；setVisible 的停止/恢复时钟由 targeted tests 覆盖。现有约19–23ms GPU span 仍是预算问题，本单元不能据此宣称稳定60FPS。Presented FPS 明确 unavailable；未运行完整 baseline 或全部 Renderer browser suite。
