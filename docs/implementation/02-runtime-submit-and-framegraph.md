# 02 · R1 单帧提交、FrameGraph 与 HZB

## 阶段目标

先降低与场景内容无关的固定成本：稳定帧以一个主要 `GPUCommandEncoder`、一次主要 `queue.submit()` 完成 upload、animation、culling、raster、lighting 和 post；FrameGraph 拓扑可缓存；HZB 不再每 mip 开 Render Pass；feature off 不产生旁路资源和提交。

## 非目标

- 不在 R1 冻结新的 Geometry/Cluster ABI。
- 不因为“一个 submit”而把资产初始化、异步编译或显式调试 readback 强塞进渲染帧。
- 不把所有代码机械塞进一个巨型 `Renderer.render()`。
- 不承诺 second chance 永远开启或永远关闭。

## 当前代码入口

| 当前入口 | 迁移问题 |
|---|---|
| `OEngine/src/gpu/GraphicsContext.ts::update()` | 创建独立 command，更新 geometry/material/statistics 后 finish |
| `OEngine/src/gpu/GPUSceneContext.ts::update()` | animation command 无条件 finish；增量 database flush 也可创建 command |
| `OEngine/src/framegraph/ShadeGPUCommandContext.ts` | `finish()` 的提交所有权需收口 |
| `OEngine/src/render/Renderer.ts` | 每帧 `new FrameGraph(...)`，图拓扑与动态数据混在一起 |
| `OEngine/src/framegraph/FrameGraph.ts` | compile/execute 已存在，但需分离 compiled topology 与 frame bindings |
| `OEngine/src/render/HierarchicalZBuffer.ts` | mip0 与后续每 mip 使用独立 Render Pass |
| `OEngine/src/render/ViewContext.ts`、`RenderTargets.ts` | resize、history 和 per-view resource owner |

## 目标帧所有权

```text
FrameCoordinator.beginFrame()
  ├─ apply CPU Change Set
  ├─ obtain cached CompiledFrameGraph
  ├─ create one main GPUCommandEncoder
  ├─ encode dirty upload + animation
  ├─ execute graph passes into same encoder
  ├─ optional sampled timestamp/counter copies
  └─ finish + queue.submit once
FrameCoordinator.endFrame()
```

### 允许的非主帧提交

以下提交必须带明确分类并进入 submit counter，但不计为“稳定帧主要 submit”：

- device 初始化和一次性默认纹理上传；
- 用户显式发起的资产预上传/烘焙；
- benchmark 明确开启的 readback；
- device lost 恢复；
- 无法并入当前帧、且 API 明确异步的工具操作。

一旦操作发生在每个稳定 render tick，它就必须并入主 encoder 或被删除。

## 计划模块

建议新增或重构为：

```text
OEngine/src/render/FrameCoordinator.ts
OEngine/src/framegraph/CompiledFrameGraph.ts
OEngine/src/framegraph/FrameGraphCache.ts
OEngine/src/framegraph/FrameGraphKey.ts
OEngine/src/render/ComputeHierarchicalZBuffer.ts
```

建议逐步移除 `ShadeGPUCommandContext` 的隐式提交能力：它可以作为 encoder façade 暂时保留，但 `finish()` 只能由 frame coordinator 或显式 one-shot owner 调用。

## 数据与生命周期契约

### FrameGraphKey

key 只包含会改变图拓扑或资源描述的值：

```text
deviceCapabilityProfile
internalWidth × internalHeight
outputWidth × outputHeight
viewCount
sampleCount
enabledFeatureBits
visibilityImplementation
historyFormatRevision
```

相机矩阵、light count、instance count、时间、dirty ranges 和当前 texture handles 是 frame bindings，不进入 key。key 相同必须复用 compiled topology、pipeline layout 决策和 transient allocation plan。

### FrameUploadBatch

CPU producer 是 Asset residency、World Change Set、animation 和 table owner；GPU consumer 是本帧对应 Pass。batch 至少记录 buffer copy/write ranges、texture uploads、总字节、owner 和最晚消费 Pass。相邻 range 可合并，但不得越过不同 owner 的生命周期。

### HistoryState

每个 view 独立持有 previous depth/HZB、velocity/TAA/SSR/exposure history。状态至少包含 `valid`、尺寸、camera cut revision、render scale revision、feature revision 和 lastWrittenFrame。resize、device lost、camera cut、切换相机、相关 feature off/on 必须使对应 history 失效。

## Compute HZB 契约

- reverse-Z 下每级保存覆盖区域的最远保守深度，具体 reduce 运算与 culling compare 写成共享测试。
- mip0 从最终 depth 复制/归约；其后 mip 在同一个 Compute Pass encoder 中依次 dispatch。
- WebGPU 同一 texture 的不同 mip view 在相邻 dispatch 中读写时，bind group 和资源 usage 必须通过 validation；不能依赖未定义的 pass 内 barrier 行为。
- 如果单 pass 多 mip 在目标实现上不可验证，则允许少量 Compute Pass 分段，但禁止回到每 mip一个 Render Pass。
- 每个 view 每帧默认只生成 final HZB；只有 same-frame late visibility 真正启用时才增加 current HZB，并单独计时。

## 执行任务

### FG-01 · 枚举所有 submit owner

使用静态搜索和 R0 runtime counter 列出每个 `createCommandEncoder`、`finish`、`queue.submit`、`mapAsync`。为每个调用标注 `steady-frame`、`one-shot`、`debug` 或 `recovery`。未知调用不得跳过。

### FG-02 · 建立 FrameCoordinator

让 `Renderer.render()` 把主 encoder 传给 Graphics、GPUScene、upload 和 graph execute。旧 helper 若没有工作，不得创建 command；有工作时只 encode，不 submit。

### FG-03 · 让动画和增量同步按 dirty 编码

`GPUSceneContext.update()` 在没有动画、transform、bounds、material/light 或 residency 变化时返回空 batch。增量 upload 与 animation dispatch 使用主 encoder。结构变化与字段变化分别计数。

### FG-04 · 收口 statistics/readback

接入 R0 readback ring。普通帧禁止 `GPUCollectionLimits.readback()` 自建 encoder/submit；只有 sampled frame 在主 encoder 末尾 copy，异步 map 旧 staging slot。

### FG-05 · 分离图描述与帧绑定

把 `Renderer.ts` 中每帧重复的 pass/resource 声明变成可缓存 graph recipe。compile 结果包含 pass order、culled pass、resource lifetime 和 transient alias plan；execute 只绑定本帧 imported resources 与 job data。

### FG-06 · 实现 feature pruning

每个 feature 从 graph recipe 入口控制。关闭时不创建 Pass、history、transient texture、timer marker、readback 或 submit。用 graph dump 自动断言，不靠人工看代码。

### FG-07 · 重写 Compute HZB

先用固定 8×8/奇数尺寸 depth 金标验证每个 mip，再替换 `HierarchicalZBuffer.ts` 运行路径。记录 build 次数、mip dispatch 数、读写像素和 GPU 时间。

### FG-08 · second-chance 调度策略

将 previous-HZB-only 和 same-frame late visibility 表达为同一 graph recipe 的条件节点。条件来自配置、相机/场景运动信号和后续 profile，不得把“Fast/Robust”实现成两条长期管线。

### FG-09 · 生命周期与恢复

验证 resize、DPR、dynamic resolution、feature toggle、view 删除和 device lost。旧 compiled graph、texture view、bind group、history 和 staging slot 必须可销毁或重建。

### FG-10 · 删除旧提交旁路

删除主帧内自建 encoder 的 helper、无条件 animation flush、每帧统计 readback和旧 HZB render pipeline/shader。临时 adapter 必须在本任务收尾清零。

## 验收

### 正确性

- 空场景、A/B/C、resize、camera cut、feature toggle 和 device lost 恢复无 validation error。
- compiled graph key 改变时正确重建，不改变时保持 cache hit。
- Compute HZB 与 CPU/reference pyramid 在小尺寸、reverse-Z、奇数边界和全远平面输入一致。
- previous/current/final HZB 不发生跨 view、跨尺寸或错误相机复用。

### 性能

- warm steady frame：一个主要 submit；非采样帧零 statistics readback。
- graph compile 只在 key 改变时发生，warm cache hit 接近常数绑定成本。
- HZB 不再每 mip 开 Render Pass；A/B/C 记录重写前后 GPU 时间。
- feature off 的 graph dump、资源峰值和 timestamp 中均不存在对应成本。
- 空场景和简单场景 CPU P95、GPU P95 不劣于 R0；若某项回退，必须定位和修正后才能过 gate。

## 回退与失败条件

- 单 encoder 导致 uploader 生命周期冲突：修正 upload batch/资源 owner，不恢复每帧独立 submit。
- graph cache 因动态值频繁 miss：把非拓扑数据移到 frame bindings，不扩大 key。
- Compute HZB 在部分设备 validation/性能失败：保留一个 WebGPU 合法的 Compute fallback；旧逐 mip Render Pass 只可短期对照，不能通过 gate。
- same-frame second chance 没收益：从默认图裁掉，保留条件功能节点，不影响 previous-HZB 主链。

## 阶段退出

`FG-01` 至 `FG-10` 完成；提交、readback、graph compile、HZB 次数均能由自动 counter 证明。更新 platform/performance/visibility Context、`CURRENT-STATE` 和相关性能 lesson，然后进入数据 ABI 与资产阶段。
