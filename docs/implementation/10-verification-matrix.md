# 10 · 验证矩阵与发布门禁

## 目标

为每个阶段定义可以自动化、复现和否决错误实现的验证。构建通过只证明 TypeScript/WGSL 被接受，不证明 GPU producer/consumer、渲染正确性或性能完成。

## 验证层次

```text
Schema/unit
  → CPU reference/property tests
  → WebGPU micro tests
  → vertical frame tests
  → image/sequence regression
  → A/B/C performance
  → target-adapter/browser and capability fallback
```

越靠下成本越高。上层失败时停止下层 benchmark，避免用 FPS 掩盖 ABI/画面错误。

根目录 `examples/` 承载可交互、可截图的 vertical frame test。示例从相对路径加载 `OEngine`，固定场景输入与 seed，并把控制台错误、关键 counter 和预期输出写入自身 README。TypeScript 测试继续负责纯逻辑与 schema，但不能替代真实 WebGPU 页面。

## 结果元数据

所有 GPU/性能结果至少记录：

```text
resultSchemaVersion
git commit + dirty state
OS / browser / version
adapter / architecture description / driver when exposed
WebGPU features + limits
canvas pixels / internal pixels / DPR / render scale
scene asset hashes / seed / camera path
feature bits / capability profile / SW-HW thresholds
warm-up / sample count / profiler sampling cadence
timestamp availability
validation errors / device lost count
```

缺少同条件元数据的结果只能作为诊断附件，不能通过 gate。

## 测试类型

### Schema 与单元测试

- TypeScript/WGSL stride、offset、alignment、sentinel、encode/decode。
- Stable handle allocate/free/reuse/generation/wrap/deferred reuse。
- Package header/section/range/checksum/version/schema hash。
- VisibilityKey min/max/empty、Material/Texture refs。
- FrameGraphKey 相等性、feature pruning、resource lifetime。

### CPU reference/property tests

- Meshlet limits、hierarchy cycle/orphan/parent-child coverage/error monotonicity。
- BVH8 quantize/decode conservative bounds。
- frustum/cone/SSE/hysteresis traversal。
- reverse-Z HZB reduction/occlusion compare。
- triangle clip/top-left/barycentric/depth/gradient/velocity。

随机/property case 必须保存失败 seed，能转成固定 regression。

### WebGPU micro tests

- upload/copy alignment、table grow、device epoch。
- queue append、atomic reservation、overflow/fallback、indirect args clamp。
- ping-pong traversal rounds 与空 indirect dispatch。
- atomic reverse-Z depth、visibility tie、SW/HW transfer。
- texture bank sampling、analytic gradients、Surface formats。
- timestamp/readback ring 不阻塞与 capacity exhaustion。

### Vertical frame tests

至少有以下最小场景：empty、single triangle、shared-edge quad、overlap/tie、single Meshlet、two-level hierarchy、Packed instances、alpha-tested、multi-material、one/many lights、camera cut、resize、feature toggle、asset unload/reload 和 device lost simulation（能力允许时）。

### 默认中等验证

普通实现批次不默认启动大规模 review 或跨设备矩阵。最低执行命中单元测试、typecheck/build、一个相关 `examples/` 浏览器场景和 WebGPU 控制台错误检查；涉及像素、LOD、遮挡、材质或时域输出时，再采集截图或短序列进行观察。阶段 Gate、ABI 大改和性能结论才升级到完整矩阵。

## 图像与数值判定

| 输出 | 判定 |
|---|---|
| VisibilityKey | 支持范围内逐像素 exact；empty exact |
| depth/HZB | 小 reference 场景按明确 float/ULP tolerance；遮挡结论不得漏绘 |
| selected cluster set | GPU/CPU set 相同；顺序可不同 |
| barycentric/UV/velocity | 数值 tolerance + 边界 case；invalid/reactive exact |
| Surface attributes | 在线性空间比较；normal angular error、roughness/metallic absolute error单列 |
| PBR/IBL/HDR | 先比较线性 HDR 数值，再比较 tonemapped screenshot |
| TAA/SSR/AO | 固定相机序列，检查 temporal error、ghosting/disocclusion，不只单帧 SSIM |

容差由首个 reference test 写入测试文件和结果 schema；不得为让失败消失而全局放宽。

## 性能统计

- 每个 case 至少经过固定 warm-up，再采集足够帧输出 median/P50、P95、P99；实际帧数由 R0 噪声分析冻结。
- cold pipeline compile、asset upload 和 warm steady-state 分开。
- CPU、GPU、submit/readback、工作量、resident/transient/upload bytes 同时输出。
- 至少重复多轮并报告轮间方差；系统明显受后台任务影响的 run 作废并保留原因。
- profiler off 数据用于最终性能，profiled sampled run 用于分段；两者都保存。

在下一正式性能阶段前创建/刷新 `performance-targets.json`，在目标桌面 GPU 写入 A/B/C 的绝对与相对门槛。没有填写目标数字前，R4/R5 不得声称“追平 three.js”或达到最终 AAA-like 性能。

即使 A/B 达到目标数字，也只能声明“最低垂直基线通过”。只有 C 的多资产/Packed Instance/hierarchy、single resolve、动态灯光、CSM、Temporal/Upscaling、内存、feature-off 和 capability fallback 同时通过，才可以声明当前 OEngine 阶段完成。超大世界、完整动态对象生命周期和专用内容系统不属于当前 Gate。A/B/C 使用同一主管线，不接受 benchmark 专用 Renderer。

### 建议的初始回归规则

在 R0 噪声小于阈值后采用以下初始规则，后续可根据统计修订并记录原因：

- 不相关场景 GPU/CPU P50 回退超过 3% 或 P95 回退超过 5% 时阻塞；
- submit、readback、overflow、validation error 属于 exact gate，不使用百分比豁免；
- 有意画质增加必须提供 feature-off 同条件结果和 feature-on 增量预算；
- A 的目标微三角形区间，Hybrid 必须优于新 HW-only，且与 three.js 对齐结果达到 `performance-targets.json`；
- B 的相同 PBR/IBL 基础链达到目标文件，附加效果不得混入比较；
- C 不要求单个样例数字掩盖扩展性，必须展示 instance/cluster/material/light 各轴曲线。

## 跨设备/浏览器矩阵

Gate 的具体设备名称在 R0 填入，不在文档猜硬件。最低覆盖类别：

R0 的职责是冻结目标矩阵并证明 A/B/C 采集入口、真实 counter 和 unsupported 契约能在主要 Chromium WebGPU 浏览器上运行；该职责已经完成。clean/full A/B/C 性能数据在后续阶段真正开始修改前按命中场景刷新；集成 GPU、额外离散 GPU、低 limits profile 和第二浏览器的完整算法/画质/性能执行随 G2–G5 对应能力进入 gate，不能反向阻塞 R1 分析和计划。

| 类别 | 必须验证 |
|---|---|
| 主要开发/目标 adapter | 每次阶段 gate 的完整 A/B/C |
| 至少一类集成 GPU | limits、atomic/带宽、Hybrid profile、内存峰值 |
| 至少一类离散 GPU | primitive/compute 交叉点、timestamp、P95/P99 |
| 一个低 limits/capability profile | texture banks、buffer capacity、feature fallback |
| 主要 Chromium WebGPU 浏览器 | 完整稳定帧与 validation |
| 另一可支持的浏览器/平台 | 启动协商、correct fallback、基础 vertical cases |

某平台缺少 timestamp-query 等可选 feature 时标为 capability fallback 通过，不伪造数据。64 位原子或 native-only 能力不属于 baseline gate。

## 阶段追踪矩阵

| Gate | 必过 correctness | 必出 performance | 必查结构 |
|---|---|---|---|
| G0 Observe | counter/timestamp frame 归属、debug view | A/B/C 对照契约；当前能力 artifact 可带明确 blocker | shader source map、submit/readback map、Schema v3 能力矩阵 |
| G1 Runtime | HZB reference、resize/history/device lost | 空/A/B/C fixed cost 前后 | 一个主要 submit、graph cache/off pruning |
| G2 Data | package/hierarchy data/handle/packed instances | bulk、stable frame 与 patch-density scaling | Geometry/Cluster/Instance owner、resident bytes、现有 HW consumer 接线、旧 owner 删除 |
| G3 Hierarchy | CPU/GPU selected set、overflow parent fallback | visited/selected/raster reduction | GPU闭环、旧 flat chain 删除 |
| G4 Visibility | HW/SW/Hybrid depth/key/edge/clip | triangle size sweep、跨 GPU profile | key ABI、HW fallback、旧 Visibility 删除 |
| G5 Shading | Surface/PBR/velocity/history/feature sequence | B/C materials/lights/effects curves | 单次 Resolve、off 零成本、旧 GBuffer旁路删除 |

## 需求到证据追踪

| 核心要求 | 实施任务 | 主要证据 |
|---|---|---|
| 可解释当前性能差距 | OBS-01..08 | A/B/C result + frame timeline |
| 一个主要 submit | R1-A01～A07 | submit/readback exact counters |
| FrameGraph 缓存/feature off | R1-B01～B06、R1-D01 | graph key/cache counters/dump |
| Compute HZB | R1-C01～C06 | mip numerical tests + GPU time |
| Package kernel/SourceGeometry | R2-A | deterministic schema/corruption/import tests |
| Cooker/hierarchy/BVH8 | R2-B | porting ledger + package validator + CPU selector/reference |
| Runtime Asset/stable handle/residency | R2-C | TS/WGSL schema、grow/abort/retirement、bytes tests |
| Packed Instance Set/patch/HW 接线 | R2-D | A/C JS objects、bulk/patch/upload scaling、截图/counter/timestamp |
| SSE GPU work generation | WORK-01..10 | selected set + queue/counter + indirect consumer |
| SW/HW Visibility | VIS-01..10 | pixel exact/tolerance + size sweep |
| 单次 Material Resolve | MAT-01..10 | draw count vs materials + B visual/numeric |
| 高质量效果统一主管线 | FX-01..12 | feature graph/off assertion + B/C sequence |
| 大胆删除旧实现 | DEL-00..05 | `rg`/bundle/graph dump + git diff |

## 自动化命令

当前仓库已有基础命令：

```powershell
Set-Location OEngine
npm ci
npm run build
npm test
```

`OBS-02` 已新增可在浏览器运行的 A/B/C harness，并复用统一 Result 下载 writer。非 GPU 的 manifest/hash/camera 契约由 `OEngine/tests/benchmark-scene-manifest.test.mjs` 非交互验证；真实 WebGPU Result 不能由 Node 命令伪造，必须在浏览器页面采集和导出。入口、正式/烟雾 profile 与命令记录在 `examples/benchmark-shared/README.md` 和 `OEngine/benchmarks/README.md`。

每次文档/迁移还应运行：

```powershell
git diff --check
```

以及仓库 Markdown 相对链接检查。GPU/截图/性能验证如果当前环境不能运行，交付说明必须列为未运行及原因，不能用 build 代替。

## 发布阻断条件

以下任何一项存在时不能通过对应 gate：

- WebGPU validation error、device lost 未解释、NaN/越界访问；
- 不可恢复 queue overflow 或静默漏绘/丢灯/丢透明；
- feature off 仍有 Pass/resource/readback/submit；
- 当前帧 CPU readback 决定 draw/dispatch；
- A/B 比较条件不一致却声称性能结论；
- 把 A/B 通过写成 OEngine 产品完成，或用样例专用旁路/Renderer 通过 A/B；
- C 未覆盖多资产、Packed Instances、hierarchy、single resolve、效果和内存扩展曲线，却声称已超过示例范围；
- P95/P99 回退被平均 FPS 掩盖；
- 旧 producer/ABI 长期双写且没有删除任务；
- `CURRENT-STATE`、Context、ADR 与真实运行路径冲突。

## 最终交付报告模板

```md
完成的 Gate/任务 ID：
真实运行主链：
新增/修改/删除模块：
冻结 ABI 与版本：
正确性结果：
A/B/C 性能结果：
其他场景回退：
Overflow/fallback 结果：
Feature-off 证据：
已运行命令：
未运行验证与原因：
更新的 Context/ADR/CURRENT-STATE/Lesson：
下一 Gate 的未决问题：
```
