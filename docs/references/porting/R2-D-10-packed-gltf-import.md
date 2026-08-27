# R2-D-10 · Packed glTF 静态导入契约

## Reference

- Reference ID：`R2-D-10-KHRONOS-GLTF-PACKED-IMPORT`
- upstream project：Khronos glTF
- repository URL：https://github.com/KhronosGroup/glTF
- locked commit：`fdb8ce0e2e0b7ecf3466f8dacb9f1385257b8276`
- specification：`specification/2.0/Specification.adoc` 的 Scenes、Nodes、Transformations、Meshes、Mesh Primitives、Materials 与 Accessors；结构约束同时参考 `specification/2.0/schema/*.schema.json`
- license：规范源码为 CC-BY-4.0；本地实现不复制 Khronos 表达性代码，只按规范独立实现并记录 attribution
- maturity class：official normative file-format specification
- verified on：2026-08-27
- decision：`reimplement`
- reason：glTF 是输入格式规范，OEngine 需要自己的 SourceGeometry/Packed ABI；直接采用其他引擎 Scene 对象会重新引入对象树和资源所有权耦合

## 当前支持子集与 ABI

`load_gltf_packed()` 接受 glTF 2.0/GLB 2.0，由现有 `GltfLoader` 完成 buffer、bufferView、accessor、scene/node world transform 和材质解析，再输出设备无关的：

```text
SourceGeometry[] + StandardShadeMaterial[]
+ geometry/material index typed arrays
+ object-to-world / local bounds / flags / debug ID typed arrays
```

一个 mesh 可以包含多个 primitive；每个 primitive 分别绑定自己的 attribute/index accessor 和 material，并产生一个 Packed Geometry/Instance 项。一个 node 的所有 primitive 共享该 node 经父子层次组合后的 world transform。输出不创建 `Mesh`、`Node3D`、GPU Buffer 或长期 GPU owner；Meshlet、hierarchy 和 BVH 仍由 Cooker 负责。

当前明确只支持静态 triangle primitive。skinned node、动画变形和非 triangle mode 明确拒绝并引导到 legacy animated path；未知 required extension 由 Loader 在解码前拒绝。缺失或越界 material 使用显式 default material，不让裸 glTF material index进入 GPU table。

## 保留不变量与 OEngine 差异

- glTF matrix/TRS 使用 column-major 约定；world transform 按 parent × local 组合，Packed 输出保存最终 object-to-world。
- mesh 是 primitive 集合，而不是单一 Geometry；不得丢失 primitive 独立 material、alpha mode 或 double-sided 语义。
- accessor 的 component type、normalized、byteOffset/byteStride 与 sparse 更新由 importer 解析；Cooker 接收规范化后的 `SourceGeometry`，不在 GPU 热路径重新解析 glTF。
- local geometry bounds 与 object-to-world 分开保存，由后续 GPU consumer 做实例变换；Loader 不预烘焙顶点或制造实例专用 Geometry。
- glTF 是输入格式，不是 OEngine Runtime Asset ABI；runtime 主路径仍是 Cooker → versioned package → `GpuAssetStore/GpuScene`。
- JSON/TRS 进入当前 Packed ABI 时落为 float32 matrix/bounds；该精度差异由 fixture 容差冻结，当前方向不引入超大世界 double-precision runtime。

## Failure、性能假设与验证

导入失败在创建 GPU owner 之前抛出，不留下半驻留资源。Packed seam 的性能假设是避免一 primitive 一 `Mesh/Node3D` 对象树和重复 Geometry owner；它不宣称解析 glTF 本身比其他 Loader 更快，Cooker/runtime upload 仍需各自 benchmark。

本地验证由 `packed-gltf-import.test.mjs` 拥有：基础静态 triangle、public seam/禁止 Scene 对象，以及 multi-primitive、multi-material、MASK/double-sided 和 nested parent/child TRS world transform fixture。真实 Damaged Helmet 是当前浏览器/benchmark case，继续验证完整 Loader → Cooker → Package → Packed consumer；fixture 不替代浏览器画面证据。
