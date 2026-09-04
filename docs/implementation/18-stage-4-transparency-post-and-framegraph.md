# Stage 4：透明、HDR Post 与 FrameGraph 编排

> 状态：待执行。
> 
> 目的：把透明合成、曝光/Bloom/锐化/色调映射和跨 graph 资源调度纳入同一可验证帧计划。

## 1. Transparency/OIT

- 透明对象使用独立 Forward/OIT 资源，复用不透明 lighting/shadow/GI/reflection 输入。
- Packed MBOIT 是默认目标；透明 work、raster-state bin、moment 格式、容量和 overflow 必须有界并计数。
- 透明输出必须包含 HDR、velocity/reactive 和 depth 语义；不修改不透明 Surface 和 AO。
- 当前不实现 Transmission、Refraction 和透明对象动态 GI；作为后续扩展保留，不为未实现能力创建空路径。
- 以 sorted-alpha 作为质量 oracle，覆盖重叠层数、材质、深度和运动序列。

## 2. HDR Post

固定顺序：

```text
Final HDR Internal
  → TAA/TAAU
  → Exposure Meter + Bloom Pyramid
  → Bloom Composite
  → HDR-aware Sharpen
  → Color Grading
  → Tonemap / Output Transform
  → Present
```

- ExposureSourceHDR 独立于 Bloom 开关；Bloom 不能决定曝光 meter 输入。
- 所有工作空间显式标记 scene-referred linear HDR、display-referred 和 output color space。
- Sharpen 在 Bloom Composite 后执行，避免先放大 TAA/SSR 噪声再扩散。
- 先锁定 exposure、bloom、grading、tonemap 的数值 oracle，再评估 ACES/LUT 等替换；不得靠截图调整亮度证明正确。

## 3. FramePlan/FrameGraph

- `FramePlan` 描述 shadow/main/LPV 等 graph 间依赖、更新频率和 history revision；不强制把所有工作塞进一个超级 graph。
- FrameGraph 保留 resource version、read/write、dead-pass culling、transient reuse、late binding 和 compiled cache。
- `validate()` 必须真正检查 domain、读写版本、生命周期、未声明资源和 feature-off prune；compiled execution 需要 stable topological order，而不是仅按 insertion order。
- WebGPU 仍是单 queue；FrameGraph 调度优化不能宣称产生异步 compute 并行。
- 关闭 Feature 时不分配资源、不保留无消费者 Pass、不 readback、不独立 submit。

## 4. 实施顺序

1. 先完成透明产品 ABI 和 MBOIT packed consumer。
2. 固定 ExposureSourceHDR，重排 Bloom/Sharpen/Grading/Tonemap，并建立颜色空间 oracle。
3. 将跨 graph 的 shadow/LPV/history 依赖写入 FramePlan。
4. 加强 FrameGraph validate、拓扑排序、prune、lifetime 和 debug dump。
5. 在同一提交中删除重复 post/透明资源 owner，不保留第二套生产管线。

## 5. 退出条件

- 透明重叠质量、容量、overflow、motion/reactive 通过；
- Bloom 开关不改变曝光输入语义；
- HDR 到 output transform 的颜色域可追溯；
- FrameGraph 能拒绝非法 domain/lifetime，并证明 feature-off 接近零成本；
- 所有跨 graph 资源具有 completion-safe 生命周期和 GPU timing。

