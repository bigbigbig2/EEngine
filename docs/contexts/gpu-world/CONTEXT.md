# GPU Scene / Tables Context

## 职责

长期管理 Instance、Geometry、Cluster、Material、Texture、Light 等紧凑 GPU 数据，以及 stable handle、capacity、bulk upload、字段 patch 和 resident bytes。R2 当前只冻结 Geometry、Cluster、Instance 三张必需 record table；Material 解析现有 registry handle，Texture/Light 全面重构后移。

## 约束

- 每张表只有一个 owner。
- Handle 不直接等于数组下标、JS 对象地址或裸 Buffer offset。
- 当前优化 mostly-static bulk upload；结构变化与 transform/material 字段 patch 使用不同路径。
- 所有引用可追溯到 Runtime Asset 和 Resident Resource。
- 不建设完整动态对象生命周期，但 grow/replace/destroy 必须等待正确的 GPU completion。
- texture residency 可以后加；geometry streaming 不进入当前主路线。
- R2 的 hierarchy 数据由 Cooker 生成并驻留；每帧 GPU traversal/SSE/work queue 属于 R3。
- `GpuPackedSceneRegistry` 只关联长期 Scene、InstanceSet、Geometry assets 和 material dictionary；R3 frame-local traversal/selected/raster queues 与 indirect args 由 `HierarchicalWorkGenerator` 拥有，不继续深化 registry 的临时 flat-buffer ownership。

## 当前状态

- R2-C 已实现惰性 `GpuAssetStore`：0 号 fallback、opaque generation handle、Geometry/Cluster/Meshlet records、BVH8/stream/material/index/Meshlet/child payload、bulk upload 和完成安全退休由同一 owner 管理。
- R2-C owner/patch 依据已登记为 [R2-C-07](../../references/porting/R2-C-07-gpu-scene-residency.md)：参考 AnKi 的职责分离，WebGPU owner/ABI/lifetime 为 OEngine 独立实现。
- Package records 与 GPU records 明确分离；TS packer、字段 offset、stride 和 WGSL struct 由同一 schema 校验。当前 v1 stride 为 Geometry 144 B、Cluster 128 B、Meshlet 112 B。
- release 立即使 handle/Geometry record 失效；append payload 暂计入 `reclaimableBytes`，不在 R2-C 未经 profile 建设通用 compactor。grow 只编码进调用方 command，`privateSubmitCount` 固定为 0。
- R2-C flat 黄金资产 consumer 已通过 live 浏览器 GPU roundtrip、Hardware `drawIndirect` 画面和生命周期证据，R2-C 已关闭。
- R2-D 已新增惰性 `GpuScene` 和 192 B `InstanceRecord` v2。0 号 fallback、opaque generation `InstanceSetHandle`、bulk/grow/abort/release、transform/material patch、dirty spans 与完整 evidence 由同一 owner 管理；offset 128 保存 CPU 预计算的 `previous_from_current`，奇异 motion 由 `MotionInvalid` 显式禁用，不创建私有 submit。
- `examples/r2-packed-scene` 已让 Compute producer 读取 Instance table、compact active record indices 并写完整 16 B indirect record，Hardware consumer 同时读取 Instance/Geometry/vertex bindings。live 结果为 `passed=true`、1k/10k/100k 与四档 patch 完整、stable copy/upload 为零、41,733 非背景像素且 validation/console diagnostics 为空。
- R2-D/G2 已关闭：A/B/C 与真实 glTF 使用 `GpuAssetStore + GpuScene + GpuPackedSceneRegistry`，生产 Packed Visibility/Material Resolve 直接读取新 Geometry/Instance ABI。package 主路径不创建 `MeshletGpuTable`；旧 Geometry owner 只在 legacy Scene consumer 请求时惰性创建。
- R2-D provenance 清算已补齐 [Packed Visibility](../../references/porting/R2-D-07-packed-visibility.md)、[Material reconstruction](../../references/porting/R2-D-08-packed-material-reconstruction.md) 与 [Velocity](../../references/porting/R2-D-09-packed-velocity.md)；Packed flat loop 已由 R3-D 删除，每材质 fullscreen 与独立 Packed Velocity 已由 R4-B Single Resolve 替换。
- R3-A 已冻结 multi-instance CPU oracle、Queue ABI、max-cut capacity 和 children 整组 reservation；R3-B 已由 `HierarchicalWorkGenerator` 独占 frame-local root/ping-pong/selected/dispatch/evidence/view resources，并接通 GPU Frustum + SSE selected-set producer。R3 v1 不直接消费当前独立 BVH8。
- R3 owner 不创建私有 submit/readback；示例中的 queue readback 只用于 GPU/CPU 回归。Packed alpha-tested Visibility 与 single Material Resolve 已分别由 G4-A/G4-B 接通；Packed CSM shadow consumer 仍属于 G5，不由 R3 冒充完成。
- R3-C 已由 `HierarchicalWorkGenerator` 生成 RasterWork 和完整 16 B `drawIndirect`，并在同一 submit 内被 Packed Hardware Visibility 消费。`GpuAssetStore` 对 package 中合法的 single-level/NoHierarchy Geometry 追加一个 runtime-only virtual leaf Cluster；Geometry GPU record 指向该 record，capacity/CPU oracle 使用相同的一 Cluster/全 Meshlet 语义，Package ABI 保持不变。
- R3-D 已删除 `GpuPackedSceneRegistry` 的 flat queue/indirect/candidate owner，schema v2 明确 `flatWorkBytes=0`；frame-local root/ping-pong/selected/RasterWork/indirect 继续由 `HierarchicalWorkGenerator` 唯一持有。previous HZB 复用 view owner 的 committed history，不复制纹理 owner。
