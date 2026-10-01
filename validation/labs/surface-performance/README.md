# Surface 性能定位实验

本地集成的 diagnostic-only 宿主，复用 `next-renderer-showcase` 的 Dungeon、发布、FrameGraph 与 GPU consumer。独立 Document/device、Chrome 临时 profile；不修改引擎生产 shader，不提交 accepted evidence，不使用 shader 编译禁用优化开关。源码由私有 Vite 宿主在编译时明确改写，预期函数/边界不存在时失败；示例正常入口不加载这些改写。

## 运行

从仓库根目录执行，默认打开本机有界面 Google Chrome：

```powershell
node validation/tools/run-surface-performance.mjs --frames 120 --warmup 60 --batches 2
node validation/tools/analyze-surface-performance.mjs .local/validation/<运行目录>/suite.json
```

小批编译/采集检查：

```powershell
node validation/tools/run-surface-performance.mjs --modes production,material-only --frames 20 --warmup 10 --batches 1
```

参数：`--chrome <chrome.exe>`、`--width 1280 --height 720`、`--coverage low,high`（默认两组）、`--view overview|detail`、`--modes <逗号列表>`、`--no-counters`、`--no-sensors`、`--out <目录>`、`--port 4180`。`--headless` 必须显式选择，不能与有界面结果混用。

## 固定采集合同

- 等待 WebCook/产品发布 settled，固定相机 transform 和 view-projection、1280×720 默认内外尺寸、SSE=4、太阳、曝光、1/60s delta。关闭交互和自动旋转；普通 HUD 最多每 250ms 更新。
- 默认分别测试 GPU `surfaceVisiblePixels / (width × height)` 为 **25%–35%** 和 **80%–90%** 两组。准备阶段在帧批次之间调整相机距离；每次调整后等待驻留 signature、异步上传和可见像素计数连续稳定。最多 16 次相机校准、每次最多 384 准备帧，无法满足条件直接失败。
- 首个 production 校准成功后，按组记录实际距离；同组其余模式及第二批锁定该距离，不重新择优选相机。测量期不改变相机；驻留变化、像素计数变化或占用超范围均使采集失败。`--no-counters` 仍在准备阶段读取计数，测量覆盖与固定负载检查标未知。
- 预热固定帧数后采集**预先确定的连续提交帧区间**，两帧背压仍生效；停止继续提交，再等待 timestamp/counter 异步结果。结果以 frameIndex 替换，pending patch 不制造重复帧。
- 每个实验使用独立页面与 WebGPU 生命周期；第二批按反序运行。预热与采集分开，但没有排除采集中的慢帧、降频帧或编译抖动。报告 sample count、P50/P95、全部逐帧 intervals、完整 counters、错误、提交数和 FrameGraph。
- GPU 合计是同帧 pass intervals 之和，不是 FPS 或 GPU queue wall time。同一个 label 重复出现时先在帧内求和，再求分位数；不能把各 pass 的 P50 相加。
- 没有 timestamp-query、缺失/零总时间戳、隐藏页面、错误或异常提交均不构成成功采集；未测量字段保持缺失，不能伪造零。
- `source-fingerprint.json` 保存包括 dirty 源码的 hash，另存 Git revision、dirty paths、GLB hash、浏览器、adapter/features/limits。它是诊断新鲜度记录，不替代正式 clean revision 条件。
- NVIDIA 环境每秒调用 `nvidia-smi`，记录查询 UTC 起止、GPU UUID、温度、利用率、graphics/memory clocks、功耗。缺失工具时记录 unavailable，不因此将温控因素判为已排除。多 GPU 不自动归属 WebGPU adapter。
- 每帧记录 CPU encode 起止和首次有效 GPU 结果被观察的 UTC。传感器与这些窗口交叠只提供粗关联；WebGPU timestamp 没有与 UTC 校准，不能据此证明某一帧一定因温控变慢。

## 实验与解释

| 模式 | 保留/移除内容 | 能定位什么 |
| --- | --- | --- |
| production | 完整生产着色 | 总成本、采样减量、长尾、跨 revision 同画质基准 |
| geometry-only | 保留 setup、透视重心、位置/法线/顶点色恢复，并编码到输出；去除 lit 材质纹理和 lighting | 几何恢复及其调度压力是否占大头 |
| material-only | 保留材质求值，参数编码到输出；替换照明函数 | worker 对 lighting 的敏感程度 |
| no-ibl | 保留 local direct + physical sun；删除天空漫反射与环境镜面消费；共享 DFG/energy 仍可能被 direct 使用 | 环境照明消费的敏感程度 |
| no-direct | 删除灯表 direct 和太阳反射项，保留环境照明 | direct 计算与灯表依赖的敏感程度 |
| no-shared-setup | 保持实际表面/照明计算，改用直接 setup 恢复 | 16-slot 表、原子、barrier、共享内存是否净获益 |
| no-worker-statistics | 删除 worker 的逐样本诊断 atomicAdd；保留 Builder/容量预约与正确性控制 | 诊断竞争是否显著干扰 worker |

所有消融改变编译器 DCE、寄存器生命周期、occupancy 或图像；差值**非可加的精确组件成本**。geometry/material 诊断会显著改变画面；setup/统计诊断仍需独立图像正确性检查才可采用。不同图像会改变 FSR3/Bloom，因此定位 worker 时看 worker interval，并同时保留整图成本。

分析器只和同批、同实际相机/尺寸/效果/时间步的 production 比较敏感程度，并检查可见像素数；同像素数不是逐像素 VisibilityKey 相等证明。统计关闭时无法完成该覆盖计数检查，必须标未知。

## 定位顺序

1. 先重复 production，查看全 GPU pass 是否同步变慢和时钟/温度窗口；污染明显时保留数据但不宣称稳定性能。
2. 查看 Probe/Builder/空 closure 成本与 material/lighting/full/coarse/fallback/overflow。全率时不能把采集成功当优化成功。
3. 比较 material-only、no-ibl、no-direct、geometry-only，确定进一步实验范围；不要用四个耗时相减拼出精确原 shader 分解。
4. 用 no-shared-setup/no-worker-statistics 检查当前调度开销。对胜出的候选实施完整生产优化后，再跑 production、画质和生命周期检查。
5. 空间复用验证增加受控材质：常量、非恒定 albedo、ORM/AO、双面、normal map、薄高光、UV 接缝与密集小三角形；分别测试全景/近景/运动。受控 oracle 不替代 Dungeon 实景性能。

示例调试面板也提供完整画面的固定采集及 AO/FSR3/Bloom 关闭实验和完整 JSON 导出；它属于开发诊断，正式验收仍使用仓库的 validation 协议和固定条件。
