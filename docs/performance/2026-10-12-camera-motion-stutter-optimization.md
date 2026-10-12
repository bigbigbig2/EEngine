---
id: camera-motion-stutter-optimization-2026-10-12
state: history
---

# Dungeon 相机交互尖峰优化（2026-10-12）

用户报告原分辨率和 0.667 都会在旋转、平移、缩放时从约 60 FPS 降到 40 多，并间歇顿挫。本记录保留工作树实施、失败和有限验证；当前单元状态只读[执行计划 §8.2](../next-execution/eengine-v5-final-pixel-performance-execution-2026-10.md#82-用户追加的相机交互尖峰单元2026-10-12)。没有修改 FSR、Native Temporal shader、几何选择或 VSM 质量参数。

## 1. 定位与实施范围

OrbitControls 事件仅累积输入，每 RAF 消费一次；相机矩阵工作没有发现随材质或几何规模增长的循环。真实普通示例的交互 CPU P50 约 0.03–0.045 ms，不能将它称为主要已证实瓶颈。

PhysicalEnvironmentRuntime 沿用相机 XYZ 每 25 场景单位量化的探针语义。跨格后原 PhysicalSkyIblResources 每次重新生成辐射图、漫反射卷积、7 层源 mip、8 层镜面预过滤，共 17 dispatch。GTX 1650 Ti 实际旧 producer 稳态单次约 2.075–2.133 ms；首次 22 dispatch 包含大气 LUT 和 DFG，不混入稳态比较。

Local：PhysicalSkyIblResources 保留最近 4 组不可变输出。缓存身份包含 producer 实际 f32 uniform 的所有 u32 位、lutGeneration、三项被采样 LUT view 及 sampler 身份。全字段仍由原完整 shader 生成，无近似、降采样、缩率改变或新的算法 donor。record 命中只暂存选择；commit 才改变 active/LRU，abort 不销毁旧缓存或推进 LRU。被淘汰组在覆盖此前所有 queue 使用的本次提交完成后销毁；destroy 清理缓存、pending、retired，分配中途失败回滚已创建纹理。

DungeonFramePacing 的普通交互模式只在先前 RAF 提交延期时响应 GPU ready，以已完成输入更新的相机状态重试。成功后重复 ready 不再提交；ready 不调用 controls.update。暂停/隐藏重置延期状态，单步仍只消费一次输入。Renderer 的两个在途帧上限、单 command submit、history/abort 协议没有改变。此项删除的是恢复后等待下一次 RAF 的额外延迟，不宣称 GPU 单帧变快。

## 2. Cost Card

| 项目 | 旧路径 | 新路径 |
|---|---|---|
| 已生成探针返回 | 新建 3 纹理、uniforms、17 bind groups/dispatch | 至多 4 项冷路径查找；命中不分配、不上传、不 dispatch |
| 新位置/光照/LUT | 完整生成 | 同样完整生成，原 ALU、采样、格式和写域 |
| 每组纹理 | source/specular 各 128²、8 mip、RGBA16F，diffuse 32² RGBA16F | 同一产品，每组 357,712 B |
| 稳态容量 | 一组 357,712 B + 固定 DFG | 四组 1,430,848 B + 固定 DFG；增量 1,073,136 B（约 1.02 MiB） |
| 重叠寿命 | 新组及 fence-retired 旧组 | 容量 4，另有 pending/retired；生产重叠受既有 2/3 在途提交约束，不能将稳态容量冒称同时峰值 |
| 全屏流量/atomics/history | 无新增 | 无新增；只有效果 owner 的小型 IBL 资源保留 |
| 交互调度 | 延期后等下一 RAF | 只重试未提交 tick；会更及时产生 GPU 工作，可能提高持续负载，不是降温机制 |

设探针请求缓存命中率 H，每次完整生成成本 G，冷路径查找成本 L。理想收益 H×G−L；0/50/100% 命中分别为 −L、0.5G−L、G−L，并承担最多约 1.02 MiB 稳态容量税。单调经过全新格子不节省 GPU 工作；往返命中删除完整 17 dispatch 是实际收益。无消费者、不同时保留两个 renderer、无独立 submit 或本帧 GPU→CPU→GPU 控制。

## 3. 实际验证与原失败

- Engine typecheck/build、fresh build:test、Dungeon typecheck/build、20 项受影响 Node 合同通过。
- 实际 GPU `physical-sky-motion`：三个探针的 12 次往返，对完整 8 层镜面 mip 和漫反射全域读取作严格 u32 比较，共 3,293,136 B 一致。9 次返回命中均无 producer dispatch；新位置仍 17 dispatch，约 2.08 ms。此数是各 producer pass duration 的逐请求总和，不是整 Renderer 帧时间。
- `ibl-publication` 和 `final-pixel-feature-demand` 实际 GPU 通过，GPU/scoped errors 为空；覆盖旧来源采样、Sun/probe 更新、真实 Renderer 域切换和生命周期边界。
- 新 Node 合同覆盖 4 项 LRU、cache-hit abort、完整参数/LUT/sampler identity、分配失败重试、pending/cache/retired 销毁及 fence 回调。交互合同覆盖延期累计 dt、重复 ready、暂停单步、隐藏窗口和无额外输入 tick。
- 新 `validation/tools/run-dungeon-camera-motion.mjs` 使用普通 interactive 宿主及真实 OrbitControls pointer/wheel 处理，1920×1080、两种 scale、每动作 180 RAF 输入 tick。全部物体与原材质保留。before/after 两组 8 窗口均无浏览器错误；释放后观测到的 PhysicalSkyIBL 纹理为 0。保存截图，旋转后场景/材质/阴影存在；不是冻结同姿态动态画质 golden。
- 原 `run-dungeon-performance` 大视角基线因 Dungeon-only coverage 12.7% 未满足其 ≥80% 近景门而失败；保留 `before/`，没有放宽该门或把此轮变成正式 qualification。
- 第一次普通交互宿主因隐藏的 profile 控件不可点击失败，保留 `interactive-before/`；诊断脚本改为显式设置同一控件并触发原 change handler，成功结果另存 `interactive-before-2/`。失败不是 renderer 失败。

## 4. 普通交互观测与限制

| Scale / 动作 | Before 提交 FPS | After 提交 FPS | 天空生成次数 Before→After |
|---|---:|---:|---:|
| 1 / 静止 | 52.80 | 46.30 | 0→0 |
| 1 / 旋转 | 55.54 | 51.42 | 22→13 |
| 1 / 平移 | 53.00 | 51.76 | 3→0 |
| 1 / 缩放 | 53.60 | 49.44 | 4→0 |
| 0.667 / 静止 | 69.88 | 57.37 | 0→0 |
| 0.667 / 旋转 | 59.72 | 61.65 | 21→12 |
| 0.667 / 平移 | 60.56 | 57.00 | 4→1 |
| 0.667 / 缩放 | 55.52 | 59.50 | 7→1 |

全部窗口保留。89–91°C、边界频率 Before 510–1350 MHz、After 300–1320 MHz；不同实际 RAF 时间也改变阻尼后相机姿态和采样工作。没有锁频、精确热条件、同提交姿态 replay 或长窗口 ABBA，因此不能将上表升降归因于新代码，不能声明整帧净收益、稳定 60 FPS 或全部顿挫修复。0.667 部分窗口缺 profiler GPU span 汇总，保留为缺项，不用 RAF 或 FPS 替代 GPU 时间。

首访 IBL、VSM 页面更新、HZB recovery/LOD、真正 Upscaler 的 scatter、热降频仍有成本；本单元没有证明它们是该用户顿挫的全部根因，也没有因未定位而改变画质或几何。

原始结果：[本机附件](../../.local/camera-motion-20261012/)中的 `sky-before/after/final.json`、`ibl-publication.json`、`feature-demand.json`、两组 interactive report/截图及失败目录。`before-dist/`为逐文件 SHA256核对的修改前普通示例构建；Windows 尾点 license 文件的第一次复制失败保留在工具记录，改用 literal long path 完整核对，未删原文件。三个 GPU oracle 都使用真正生产 owner，缓存不是 test-only selector。

## 5. 复现

```powershell
npm --prefix OEngine run build
npm --prefix OEngine run build:test
npm --prefix examples run typecheck:dungeon
npm --prefix examples run build:dungeon
node --test OEngine/tests/contract/physical-sky-cache.test.mjs OEngine/tests/contract/physical-environment.test.mjs OEngine/tests/unit/orbit-controls.test.mjs examples/tests/dungeon-frame-pacing.test.mjs examples/tests/dungeon-resource-budget.test.mjs
node tools/gpu-oracle.mjs physical-sky-motion --json
node tools/gpu-oracle.mjs ibl-publication --json
node tools/gpu-oracle.mjs final-pixel-feature-demand --json
node validation/tools/run-dungeon-camera-motion.mjs --out .local/camera-motion-recheck --ticks 180
```

GPU 作业串行。正式 Phase6、长窗口同条件帧率/尾延迟及完整 authored Dungeon 动态质量不由该诊断替代。
