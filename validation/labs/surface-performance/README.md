# Surface V3 性能测量设施

本地 diagnostic-only 宿主，复用 `next-renderer-showcase` 的 Dungeon、发布、FrameGraph 与 Surface V3 production renderer。独立 Document/device、Chrome 临时 profile；不修改生产 shader，不提交 accepted evidence。测量链固定为“覆盖完整性 → 实际工作量 → GPU 阶段耗时”。

## 运行

从仓库根目录执行，默认打开本机有界面 Google Chrome：

```powershell
node validation/tools/run-surface-performance.mjs --modes timing,detailed --frames 600 --warmup 300 --batches 3
node validation/tools/analyze-surface-performance.mjs .local/validation/<运行目录>/suite.json
```

小批编译/采集检查：

```powershell
node validation/tools/run-surface-performance.mjs --modes timing,detailed --frames 20 --warmup 10 --batches 1
```

参数：`--chrome <chrome.exe>`、`--width 1920 --height 1080`、`--coverage low,high`（默认两组）、`--view overview|detail`、`--modes timing,detailed`、`--no-counters`、`--no-sensors`、`--out <目录>`、`--port 4180`。`--headless` 必须显式选择，不能与有界面结果混用。

`timing` 只写 GPU timestamp；`detailed` 额外写 Surface V3 snapshot、覆盖关系和逻辑字节模型。两种模式必须使用同一批次、同一相机、同一驻留状态比较，详细模式相对 timing 的差值单独报告为测量扰动。

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

每组场景先运行 `timing`，再运行 `detailed`。两者都使用同一生产路径；`detailed` 只增加 snapshot、计数和覆盖检查。分析器同时输出：

- Surface 各阶段 P50/P95；
- `surfacePassSumMs` 与 `surfaceSpanMs`；
- tile、sample、material、geometry、lighting、reconstruct 工作漏斗；
- 覆盖方程状态、溢出、丢样和 snapshot 可用性；
- 资源分配量与 reconstruct 逻辑访问字节；
- `detailed - timing` 的整帧和 Surface 扰动。

GPU timestamp 不可用、snapshot 丢失、覆盖关系失败或生产路径发生未解释截断时，只保留诊断记录，不形成性能改善结论。

## 定位顺序

1. 先看 coverage；任何 overflow、miss queue 截断、Geometry ABI base 不一致或 snapshot dropped 都暂停性能解释。
2. 再看工作漏斗，区分 cache hit、真实 miss、evaluator 完成和字段 publication，避免把漏算当优化。
3. 再看 Surface 阶段耗时，先判断是 pass 合计、Surface span 还是区间外 provider 占主导。
4. 最后比较 `timing` 与 `detailed`，报告诊断扰动；只有完整 coverage 的 timing 数据才进入性能比较。
5. 对高频 normal/ORM、材质交错、容量压力、相机运动和 VSM 开关分别采集，不能用一个 Dungeon 总数代替覆盖。

示例调试面板也提供完整画面的固定采集及 AO/FSR3/Bloom 关闭实验和完整 JSON 导出；它属于开发诊断，正式验收仍使用仓库的 validation 协议和固定条件。
