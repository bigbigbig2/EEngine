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
- Package records 与 GPU records 明确分离；TS packer、字段 offset、stride 和 WGSL struct 由同一 schema 校验。当前 v1 stride 为 Geometry 144 B、Cluster 128 B、Meshlet 112 B。
- release 立即使 handle/Geometry record 失效；append payload 暂计入 `reclaimableBytes`，不在 R2-C 未经 profile 建设通用 compactor。grow 只编码进调用方 command，`privateSubmitCount` 固定为 0。
- R2-C flat 黄金资产 consumer 已通过 live 浏览器 GPU roundtrip、Hardware `drawIndirect` 画面和生命周期证据，R2-C 已关闭；A/C、普通 Scene adapter、Instance table/Packed source 与 legacy owner 删除仍属于 R2-D，GPU hierarchy traversal 仍属于 R3。
- R2-D 已新增惰性 `GpuScene` 和 192 B `InstanceRecord` v1。0 号 fallback、opaque generation `InstanceSetHandle`、bulk/grow/abort/release、transform/material patch、previous/current、dirty spans 与完整 evidence 由同一 owner 管理；不创建私有 submit。
- `examples/r2-packed-scene` 已让 Compute producer 读取 Instance table、compact active record indices 并写完整 16 B indirect record，Hardware consumer 同时读取 Instance/Geometry/vertex bindings。live 结果为 `passed=true`、1k/10k/100k 与四档 patch 完整、stable copy/upload 为零、41,733 非背景像素且 validation/console diagnostics 为空。
- 生产 `VisibilityPass` 与 A/C 仍绑定 legacy `MeshletGpuTable` + 分页 `SceneDatabase`。迁移并删除这些重复 owner 是 R2-D/G2 的最后任务；不能仅凭新纵切关闭整个 R2。
