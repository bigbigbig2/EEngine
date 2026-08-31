# R5-03 · Packed MBOIT Transparency / FX-05

## 登记结论

- **Reference ID**：`R5-03-packed-mboit-transparency`
- **decision**：`port mathematical invariants / reimplement WebGPU owner`
- **范围**：4 power moments 的生成与重建、保守数值失败路径；Packed hierarchy、队列、资源、FrameGraph 与 WebGPU blend/indirect consumer 由 OEngine 重建。
- **不采用**：A-buffer、PPLL、无限 fragment node pool、CPU 材质循环和每材质 draw。

## 上游来源与许可证

### Moment-Based Order-Independent Transparency

- 论文主页：<https://momentsingraphics.de/I3D2018.html>
- DOI：<https://doi.org/10.1145/3203206>
- 官方实现包：<https://momentsingraphics.de/Media/I3D2018/Muenstermann2018-MBOITCode.zip>
- 官方实现包 SHA-256：`3A09C53B232908B356633D7BC1D9D651AE502E9A73E4E161527A73305B55C1FC`
- 上游源码路径：
  - `MBOITCode/MomentOIT.hlsli`
  - `MBOITCode/MomentMath.hlsli`
  - `MBOITCode/ComplexAlgebra.hlsli`
  - `MBOITCode/TrigonometricMomentMath.hlsli`
- 本次移植实际使用：`MomentOIT.hlsli` 的 power-moment accumulation，以及 `MomentMath.hlsli::computeTransmittanceAtDepthFrom4PowerMoments` 的 4-moment Hankel/Cholesky 重建不变量。
- 许可证：作者发布说明将该实现置于 CC0；登记页：<https://momentsingraphics.de/MissingTMBOITCode.html>。仓库不复制官方压缩包或 HLSL 文件，保留 URL、hash、路径和数学移植范围。
- 上游没有 git commit；因此以官方归档的 SHA-256 作为不可变身份，不伪造 commit/tag。

### 已有 OEngine 上游链

- hierarchy/SSE/有界队列继续采用 [R3-01](./R3-01-hierarchical-work-generation.md) 冻结的 meshoptimizer/Bevy 来源和 WebGPU producer 不变量。
- `SecondaryRasterWork v1`、完整 16 B indirect 与 Packed material/texture owner 继续采用 [R4-A-01](./R4-A-01-unified-visibility-contract.md) 和 [R4-B-01](./R4-B-01-single-material-resolve.md) 的 ABI/owner 决策。
- IBL 参数和 working-linear 语义采用 [R5-01](./R5-01-surface-lighting.md)，不另造透明专用颜色空间或纹理 owner。

## 保留的算法不变量

1. fragment alpha 先转换为 optical absorbance：`b0 = -log(1 - alpha)`。
2. 4 power moments 为 `b0 * [z, z², z³, z⁴]`，通过浮点 additive blending 做顺序无关累加。
3. resolve 先以 `b0` 归一化 moments，再进行 4-moment Hankel/Cholesky 重建。
4. 单精度 bias 固定为 `5e-7`；overestimation 固定为 `0.25`，两者属于 FX-05 v1 recipe，不由每材质改变。
5. 总 transmittance 为 `exp(-max(b0, 0))`。
6. 零 optical depth、退化分母、负判别式、NaN/Inf 和近重根均 fail conservative：返回有界 total transmittance，不传播非有限值。
7. 算法是近似 order-independent，不宣称等价于 exact sorted alpha；sorted back-to-front 只作 CPU 质量 oracle。

## OEngine / WebGPU 适配

### 输入与输出 ABI

```text
Packed Instance flags (BLEND)
→ shared HierarchicalWorkGenerator
→ bounded Transparent SecondaryRasterWork queue
→ fixed 16 B drawIndirect
→ r32float optical + rgba32float power moments
→ rgba16float transparent resolved + r8unorm reactive
→ load/store composite into working-linear HDR
```

- OPAQUE/MASK 主 Visibility 和 CSM 显式排除 `GPU_INSTANCE_FLAGS.Transparent`。
- BLEND 分类来自同一 Material dictionary；bulk upload 和显式 material patch 同步更新 instance classification flags。
- 透明 producer 使用独立 main-view bounded queue，但复用同一个 hierarchy owner family；不复用 opaque queue，也不创建 legacy draw list。
- 当前只有一个固定 raster-state bin：`cullMode: none`，one-sided/double-sided 与 mirrored transform 在 fragment 中判定，因此材质数不会增加 draw/pass。
- fragment material texture sampling 使用显式 gradients，以满足 WGSL non-uniform material 分支的 uniformity 规则并保留 mip 选择。
- transparent shading 读取同一 Material/Texture、FX-02 bounded cluster/light/shadow inputs，以及 FX-03 specular environment、diffuse irradiance 和 split-sum owner，输出 working-linear HDR；不复制第二套 light-list producer。

### 资源与固定成本

- optical：`r32float`，4 B/pixel。
- four moments：`rgba32float`，16 B/pixel。
- resolved：`rgba16float`，8 B/pixel。
- reactive：`r8unorm`，1 B/pixel。
- 合计 transient 上界：`29 B/pixel`，资源由 FrameGraph 管理。
- 生产提交固定为一次 moment indirect、一次 forward indirect、一次 fullscreen composite，即 3 draw；active material `1 → 64` 不改变该数量。
- feature 未命中 BLEND 时不加入透明节点，不分配上述 transient、不创建 Packed transparent owner，也不注册独立 submit/readback。

### Queue、overflow 与失败行为

- 元素 ABI：`SecondaryRasterWork v1`；每项定位 `VisibleCluster`、meshlet record 和 raster flags。
- 容量：沿用 Packed scene 基于 hierarchy legal cut / meshlet expansion 冻结的容量，不接受运行时无界增长。
- producer：`HierarchicalWorkGenerator` 的 BLEND required-flag main-view traversal。
- consumer：`PackedTransparentOitPass` 的两个 `drawIndirect`。
- overflow：queue header 保留 attempted/written/capacity/overflow；sampled counter `transparentQueueOverflowMask` 必须非零并使 Gate 失败，禁止静默丢透明。
- moment 非有限：composite fail black/total-transmittance，并由 `transparentMomentFiniteFailures` 使 Gate 失败。
- motion v1：所有透明贡献写 reactive=1，velocity 标为无效；最终 temporal OR/组合由 FX-06B 完成。

## 性能假设

相对旧 `MaterialMeshletDrawList + per-material transparent draw`：

- 材质数不再增加 CPU 遍历、draw 或 pass；固定 3 draw。
- GPU producer 直接消费 Packed hierarchy/instance/material tables，不回到 CPU 可见列表。
- sampled counter pass 才扫描 queue/pixels；非 sampled 帧没有该 compute pass和 atomic。
- 代价是固定 `29 B/pixel` transient 与两次透明几何 raster；coverage/layer 压力通过 C-transparent Gate 独立量化，不能用功能完成掩盖预算失败。

## 本地实现与验证

- CPU reference：`OEngine/src/render/MomentOitReference.ts`
- Packed pass：`OEngine/src/render/passes/PackedTransparentOitPass.ts`
- WGSL：`OEngine/src/shaders/packed_transparent_oit.ts`
- 自动测试：`OEngine/tests/fx05-packed-transparency.test.mjs`
- 浏览器页面：`examples/r5-packed-transparency/`
- Gate runner：`examples/scripts/run-r5-fx05-gate.mjs`

自动/浏览器验证覆盖：

- 2/3/4 layer order-invariance 与 finite；
- degenerate moments conservative fallback；
- sorted-alpha CPU oracle；
- BLEND 与 OPAQUE/MASK/CSM 分类互斥；
- coverage `0/10/50%`、layers `1/4/8/16`、materials `1/8/64`；
- real queue work、exact meshlet triangles、reactive pixels、finite failure、overflow；
- moment/forward/composite GPU timestamps；
- 正逆序 PNG RMS/max-channel tolerance；
- feature-off owner/transient=0 和唯一主 submit。

## 明确未包含

- exact sorted transparency、refraction、colored transmission、particle-specific path；
- transparent velocity reconstruction；当前由 reactive-all contract 保守拒绝 history。
