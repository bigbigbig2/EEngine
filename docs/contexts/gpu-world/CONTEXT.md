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

## 当前状态

- R2-C 已实现惰性 `GpuAssetStore`：0 号 fallback、opaque generation handle、Geometry/Cluster/Meshlet records、BVH8/stream/material/index/Meshlet/child payload、bulk upload 和完成安全退休由同一 owner 管理。
- R2-C owner/patch 依据已登记为 [R2-C-07](../../references/porting/R2-C-07-gpu-scene-residency.md)：参考 AnKi 的职责分离，WebGPU owner/ABI/lifetime 为 OEngine 独立实现。
- Package records 与 GPU records 明确分离；TS packer、字段 offset、stride 和 WGSL struct 由同一 schema 校验。当前 v1 stride 为 Geometry 144 B、Cluster 128 B、Meshlet 112 B。
- release 立即使 handle/Geometry record 失效；append payload 暂计入 `reclaimableBytes`，不在 R2-C 未经 profile 建设通用 compactor。grow 只编码进调用方 command，`privateSubmitCount` 固定为 0。
- R2-C flat 黄金资产 consumer 已通过 live 浏览器 GPU roundtrip、Hardware `drawIndirect` 画面和生命周期证据，R2-C 已关闭。
- R2-D 已新增惰性 `GpuScene` 和 192 B `InstanceRecord` v2。0 号 fallback、opaque generation `InstanceSetHandle`、bulk/grow/abort/release、transform/material patch、dirty spans 与完整 evidence 由同一 owner 管理；offset 128 保存 CPU 预计算的 `previous_from_current`，奇异 motion 由 `MotionInvalid` 显式禁用，不创建私有 submit。
- `examples/r2-packed-scene` 已让 Compute producer 读取 Instance table、compact active record indices 并写完整 16 B indirect record，Hardware consumer 同时读取 Instance/Geometry/vertex bindings。live 结果为 `passed=true`、1k/10k/100k 与四档 patch 完整、stable copy/upload 为零、41,733 非背景像素且 validation/console diagnostics 为空。
- R2-D/G2 已关闭：A/B/C 与真实 glTF 使用 `GpuAssetStore + GpuScene + GpuPackedSceneRegistry`，生产 Packed Visibility/Material/Velocity 直接读取新 Geometry/Instance ABI。package 主路径不创建 `MeshletGpuTable`；旧 Geometry owner 只在 legacy Scene consumer 请求时惰性创建。
- R2-D provenance 清算已补齐 [Packed Visibility](../../references/porting/R2-D-07-packed-visibility.md)、[Material reconstruction](../../references/porting/R2-D-08-packed-material-reconstruction.md) 与 [Velocity](../../references/porting/R2-D-09-packed-velocity.md)；flat loop 与每材质 fullscreen 仍分别由 R3/R4-B 替换，不能因局部热点优化标记为长期完成。
- 当前下一步是 R3 GPU hierarchy/SSE traversal。Packed alpha-tested Visibility、Packed CSM shadow consumer 和 single Material Resolve 分别属于后续 G4-A/G5/G4-B，不由 G2 冒充完成。
