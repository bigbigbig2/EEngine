# Surface V3 1080p 性能测量报告

日期：2026-10-03。范围：当前工程的工作量、逻辑读写量与 GPU 时间测量；本报告不讨论后续优化设计，不判定新旧架构优劣。

## 测试配置与数据范围

- GPU：NVIDIA GeForce GTX 1650 Ti 4GB；Chrome 154.0.8037.92，独立有界面浏览器。
- 输出与内部尺寸均为 **1920×1080**，DPR=1，renderScale=1；**2,073,600 pixels、32,400 个 8×8 tile**。
- 场景：`dungeon_warkarma.glb`，SHA256 `cac0fc8c16d107e7ac4e69efde89c2cb6ef4bc66c34456a4dd0923218e5aafb1`。
- AO/XeGTAO、FSR3、Bloom、HZB、cone 开启；SSE=4，固定曝光=4，jitter 关闭。主表 **VSM 关闭**；VSM 开启的单独尝试见下文。
- 两档初始覆盖：32.84% / 80.40%；相机距离 scale 为 0.885 / 0.05。
- 每档分别运行 timing 与 detailed：每次正式采样 120 帧，合计 **480 帧**；每段各 40 帧。60 帧常规预热后，再预热同一相机轨迹并等待几何驻留稳定。
- 固定轨迹：前 40 帧静止；中间 40 帧围绕目标作 `0.05 × sin(πt)` 弧度水平转动并返回起点；后 40 帧静止恢复。步进依据成功提交的帧号，不依据墙上时间。
- timing 用于 GPU 时间，detailed 用于工作量及字节计数。表中计数/字节为各段 **P50**；时间为 **P50 / P95**。不同列、不同阶段的 P50/P95 不能简单相加。
- 移动段允许覆盖率随相机变化；“低/高覆盖”表示初始视角，不要求移动段始终留在原校准区间。

## Tile、sample、命中与 packet 数量

| 指标 | 低覆盖静止 | 低覆盖移动 | 低覆盖恢复 | 高覆盖静止 | 高覆盖移动 | 高覆盖恢复 |
|---|---:|---:|---:|---:|---:|---:|
| 可见像素 | 681,012 | 667,815 | 681,012 | 1,667,147 | 1,653,229 | 1,667,147 |
| Implicit（当前为空 tile） | 21,445 | 21,648 | 21,445 | 6,137 | 6,345 | 6,137 |
| 非空 implicit tile | 0 | 0 | 0 | 0 | 0 | 0 |
| Uniform tile | 2,218 | 2,149 | 2,218 | 16,838 | 16,676 | 16,838 |
| Mixed tile | 8,737 | 8,587 | 8,737 | 9,425 | 9,388 | 9,425 |
| Surface sample | 552,328 | 543,683 | 552,328 | 616,735 | 613,834 | 616,735 |
| Mixed 产生的 sample | 550,110 | 541,518 | 550,110 | 599,897 | 597,134 | 599,897 |
| sample / 全屏像素（%） | 26.64 | 26.22 | 26.64 | 29.74 | 29.60 | 29.74 |
| sample / 可见像素（%） | 81.10 | 81.37 | 81.10 | 36.99 | 37.09 | 36.99 |
| mixed sample / 全部 sample（%） | 99.60 | 99.60 | 99.60 | 97.27 | 97.28 | 97.27 |
| Geometry hit | 552,328 | 0 | 552,328 | 616,735 | 0 | 616,735 |
| Geometry miss（完成） | 0 | 543,683 | 0 | 0 | 613,834 | 0 |
| Material hit | 552,328 | 0 | 552,328 | 616,735 | 0 | 616,735 |
| Material miss（入队） | 0 | 543,683 | 0 | 0 | 613,834 | 0 |
| Diffuse 求值 | 0 | 543,683 | 0 | 0 | 613,834 | 0 |
| Specular 求值 | 0 | 543,683 | 0 | 0 | 613,834 | 0 |
| Coat 求值 | 0 | 0 | 0 | 0 | 0 | 0 |
| IBL 求值 | 0 | 543,683 | 0 | 0 | 613,834 | 0 |
| Diffuse packet 写入 | 0 | 543,683 | 0 | 0 | 613,834 | 0 |
| Specular packet 写入 | 0 | 543,683 | 0 | 0 | 613,834 | 0 |
| Coat packet 写入 | 0 | 543,683 | 0 | 0 | 613,834 | 0 |
| IBL packet 写入 | 0 | 543,683 | 0 | 0 | 613,834 | 0 |

## 每帧逻辑读写字节

| 指标 | 低覆盖静止 | 低覆盖移动 | 低覆盖恢复 | 高覆盖静止 | 高覆盖移动 | 高覆盖恢复 |
|---|---:|---:|---:|---:|---:|---:|
| GeometryRecord 写入 (MB) | 19.88 | 104.39 | 19.88 | 22.20 | 117.86 | 22.20 |
| 四类 packet 合计写入 (MB) | 0.00 | 34.80 | 0.00 | 0.00 | 39.29 | 0.00 |
| Reconstruct 逻辑读取 (MB) | 173.20 | 150.57 | 173.20 | 267.87 | 213.63 | 267.87 |
| Reconstruct 输出及历史写入 (MB) | 132.71 | 132.71 | 132.71 | 132.71 | 132.71 | 132.71 |

## GPU 分阶段时间

| 指标 | 低覆盖静止 | 低覆盖移动 | 低覆盖恢复 | 高覆盖静止 | 高覆盖移动 | 高覆盖恢复 |
|---|---:|---:|---:|---:|---:|---:|
| Visibility 全阶段 P50/P95 (ms) | 3.80 / 4.59 | 3.28 / 4.06 | 3.67 / 4.59 | 3.41 / 4.65 | 3.08 / 3.67 | 3.28 / 19.79 |
| 其中 Visibility 光栅（非额外相加项） P50/P95 (ms) | 0.59 / 0.66 | 0.52 / 0.79 | 0.59 / 0.66 | 0.33 / 0.46 | 0.33 / 0.39 | 0.33 / 2.82 |
| Surface 工作分类/收尾 P50/P95 (ms) | 0.98 / 1.25 | 0.85 / 1.05 | 0.98 / 0.98 | 1.57 / 2.10 | 1.44 / 1.51 | 1.51 / 5.05 |
| Surface 输入见证 P50/P95 (ms) | 1.11 / 1.57 | 1.38 / 1.57 | 1.11 / 1.70 | 1.31 / 1.64 | 1.77 / 1.90 | 1.31 / 2.56 |
| Surface geometry P50/P95 (ms) | 1.18 / 1.38 | 2.88 / 3.47 | 1.18 / 1.18 | 1.38 / 1.57 | 3.08 / 3.34 | 1.38 / 3.60 |
| Material lookup/驻留版本 P50/P95 (ms) | 1.84 / 2.36 | 1.51 / 1.77 | 1.77 / 2.03 | 2.23 / 2.42 | 1.84 / 2.10 | 2.23 / 4.13 |
| Material 队列整理 P50/P95 (ms) | 0.00 / 0.07 | 1.51 / 1.77 | 0.00 / 0.07 | 0.00 / 0.07 | 2.16 / 2.23 | 0.00 / 0.07 |
| Material evaluate P50/P95 (ms) | 0.00 / 0.07 | 10.55 / 10.94 | 0.00 / 0.07 | 0.00 / 0.07 | 11.80 / 12.19 | 0.00 / 0.07 |
| Lighting 分类/压缩/求值 P50/P95 (ms) | 0.92 / 1.51 | 1.97 / 2.42 | 0.98 / 1.51 | 1.11 / 1.25 | 2.29 / 2.56 | 1.11 / 4.65 |
| Reconstruct P50/P95 (ms) | 1.57 / 2.16 | 1.57 / 1.70 | 1.64 / 1.84 | 1.77 / 1.97 | 1.57 / 1.70 | 1.70 / 6.29 |
| Surface 总 GPU P50/P95 (ms) | 8.00 / 8.65 | 22.41 / 23.86 | 7.73 / 8.52 | 9.44 / 10.88 | 26.08 / 26.61 | 9.24 / 26.48 |
| FSR3 P50/P95 (ms) | 4.13 / 4.85 | 12.98 / 15.53 | 4.00 / 4.85 | 4.65 / 6.03 | 14.02 / 15.40 | 4.46 / 34.01 |
| VSM P50/P95 (ms) | 关闭 | 关闭 | 关闭 | 关闭 | 关闭 | 关闭 |
| XeGTAO P50/P95 (ms) | 1.51 / 2.10 | 1.44 / 1.84 | 1.51 / 1.70 | 2.95 / 3.87 | 2.75 / 3.01 | 2.75 / 13.24 |
| 其他阶段 P50/P95 (ms) | 1.90 / 2.23 | 1.64 / 2.03 | 1.90 / 2.62 | 2.29 / 3.08 | 2.10 / 2.23 | 2.16 / 8.13 |
| 独立诊断 Pass P50/P95 (ms) | 0.00 / 0.26 | 0.00 / 0.26 | 0.00 / 0.26 | 0.00 / 0.33 | 0.00 / 0.33 | 0.00 / 0.33 |
| 整帧 GPU Pass 总和 P50/P95 (ms) | 19.53 / 21.43 | 41.88 / 46.20 | 18.87 / 20.77 | 22.74 / 28.18 | 48.23 / 50.07 | 21.82 / 79.69 |
| 整帧首尾 GPU 跨度 P50/P95 (ms) | 20.12 / 21.95 | 42.60 / 46.79 | 19.60 / 21.36 | 23.40 / 28.90 | 48.96 / 50.66 | 22.48 / 83.17 |


## 统计口径

1. 当前 `implicit` 分类对应**空 tile**；表中另外列出非空 implicit，避免混淆。每个 Uniform tile 产生 1 个代表 sample；`Mixed sample = accepted sample − uniform tile`，仅在本次全部 overflow=0 的前提下计算。
2. Material hit 表示全部所需字段命中；只要有字段需要重新求值，该 sample 就记为 miss。hit 数量不表示 lookup 没有 GPU 成本。
3. “求值”和“packet 写入”分别计数。Coat 求值为 0 的帧仍可能写入零 coat packet；字节表包含该实际写入。复用已有 packet 不计为新的写入。
4. **MB=1,000,000 字节。这里是逻辑访问量，不是硬件测得的 DRAM 流量或显存带宽。** GeometryRecord 按源代码写入的有效字节计数；reconstruct 按每个 invocation 访问的资源格式尺寸计数。缓存、事务合并、纹理压缩和编译器访存变化未计入硬件层分析。
5. GeometryRecord：hit 仍更新 36 B 元数据；完整 miss 写 192 B；无效清空分支计 208 B。由生产者 GPU counter 写入快照，未把 hit 记成零写入。
6. Packet：每个 vec4f 为 16 B，四路分别累计；无效记录清包同样计入。
7. Reconstruct：每个输出像素固定输入访问格式量为 52 B（sample map、facts、current/previous identity、motion、previous age、pre-exposure）；有效输出像素另外读取四路 packet 共 64 B；每个实际复用的 signal history 读取 8 B。每个输出像素写 histories、identity/age、HDR/reactive 共 64 B。读取量按**输出像素**计算，不按代表 sample 数计算。
8. 字节表只覆盖指定的 GeometryRecord、packet 和 reconstruct；不包括全部 cache key/value、work queue、材质纹理等流量，不能将三行之和称为 Surface 总显存流量。
9. Visibility 全阶段包含 hierarchy、MeshletWork、frame geometry、raster partitions、Visibility raster 和 HZB。光栅行是其子集。Surface 总 GPU 包含工作分类、输入见证、geometry、material lookup/调度/求值、lighting 和 reconstruct。FSR3/XeGTAO 单独汇总，未塞进 Surface。
10. GPU 时间为 timestamp Pass 区间之和；另给首尾 Pass 跨度。它们均不能直接当作浏览器端到端帧间隔或页面 FPS。小阶段的 0.00 ms 可能受 timestamp 分辨率/取整影响，实际工作量以计数为准。

## VSM 单独开启的测量结果

**未获得有效 VSM 耗时，不能填为 0 ms。**

独立宿主启用 `Renderer.enableVsm` 后，timing 和 detailed 两次均在初始化阶段失败：

```text
TypeError: Cannot read properties of undefined (reading 'device')
at new VsmAtlasRasterPass
at Renderer.initialize
```

失败发生在正式采样之前。本轮按“仅出性能报告”的范围记录失败，未修复 VSM。仅开启运行开关、但没有创建 VSM provider 的预备试跑已排除，未用作 VSM 数据。

## 完整性与测量环境

- 主表四次 capture 均完成 120/120 帧，GPU/浏览器错误为 0，详细覆盖检查全部通过，sample/queue overflow 为 0。
- 计数器 ABI 升至 schema 2，新增 GeometryRecord 写入、packet 写入和 reconstruct 逐 signal history 读取计数，修正此前 reconstruct 字节估算。
- 6 项实际 GPU 字节账本 oracle 通过，包含“1 个 sample 服务 64 个像素”“命中仍写元数据”“无效映射只查有效位”和“零 coat packet 仍写入”等情况。OEngine typecheck、build:test、两个相关 targeted tests，以及 examples build 通过。
- 主测试传感器窗口为 65–90°C；159 个传感器样本中 65 个记录 thermal slowdown Active。所有长帧均保留；高覆盖恢复段的整帧 P95=79.69 ms，未剔除或平滑。温度/时钟不与单个 GPU Pass 作精确因果对应。
- 当前数据是一次本机诊断采样，不是旧版 full-resolution/sample-driven 与 V3 的同条件历史 checkout 对比。这里不附带架构优劣结论。

## 数据文件与复现

- [完整 suite、传感器和逐帧 timestamp](../../.local/validation/surface-v3-work-bandwidth-final/suite.json)
- [逐帧 CSV](../../.local/validation/surface-v3-work-bandwidth-final/per-frame.csv)
- [工作量与阶段汇总 JSON，含 label 归属](../../.local/validation/surface-v3-work-bandwidth-final/work-ledger.json)
- [GPU 字节 oracle](../../.local/validation/surface-bandwidth-oracle/report.json)
- [VSM 初始化失败记录](../../.local/validation/surface-v3-work-bandwidth-vsm-active/suite.json)
- 源文件身份随 capture 保存于 `source-fingerprint.json`，原始数据未用后续运行覆盖。

```powershell
node validation/tools/run-surface-performance.mjs --port 4201 --width 1920 --height 1080 --frames 120 --warmup 60 --batches 1 --modes timing,detailed --coverage low,high --trajectory orbit-return --out .local/validation/surface-v3-work-bandwidth-final
python validation/tools/summarize-surface-work.py .local/validation/surface-v3-work-bandwidth-final
node validation/tools/run-surface-bandwidth-oracle.mjs
```

VSM 单独测试使用 `--vsm --coverage low --frames 60`，省略 `--trajectory orbit-return`，输出到独立目录。
