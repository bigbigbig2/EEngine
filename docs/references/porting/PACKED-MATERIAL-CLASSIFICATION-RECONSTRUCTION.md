# 可见像素分类、专用 Material Resolve 与按需 Surface 移植登记

Reference ID: `PACKED-MATERIAL-CLASSIFICATION-RECONSTRUCTION`

Status: production code migrated; WebGPU diagnostics and paired performance Gate pending

对应当前事实：[STATUS](../../implementation/STATUS.md)。本登记覆盖第二步 `VisibilityKey → Material Resolve → Surface`，不把尚未执行的浏览器或性能 Gate 写成已完成证据。

## 采用矩阵

| 能力 | 来源 | 固定版本 | 许可证 | 决策 |
|---|---|---|---|---|
| visible-pixel class/compact 合同 | The Forge Visibility Buffer triangle filtering/compaction | `cd5046893faba2dc7869243873bf01f02a6f0df9` | Apache-2.0；相关 AMD block MIT | 移植 producer/compact 不变量，不复制 native command model |
| block exclusive scan | GPU Gems 3 Chapter 39, *Parallel Prefix Sum (Scan) with CUDA* | published chapter | NVIDIA publication；未复制表达性代码 | 按算法规格独立实现，并提供 CPU oracle/property regression |
| WebGPU execution and indirect draw contract | W3C WebGPU / WGSL specifications | 仓库当前 WebGPU baseline | W3C document license | 按规格独立实现 |
| Standard PBR/UV/texture transform reconstruction | 既有 `R2-D-08`、`R4-B-01` 登记 | 对应登记固定版本 | 对应登记许可证 | 保留已验证数学与材质语义，替换调度和热路径 |

没有从 `three.js/` 复制运行时代码；它仍只是本地行为对照。没有采用 decoupled look-back、subgroup、wave intrinsic、64-bit atomic、bindless 或 multi-draw-indirect，因为这些不属于当前 WebGPU baseline，且部分方案依赖设备前向进度保证。本实现不是单 workgroup 或固定长度示例：scan 递归覆盖任意合法 framebuffer workgroup 数，并向下传播 block prefix。

## 输入、输出与 owner

```text
producer:
  VisibilityKey texture + exact RasterWork + MaterialRecord.kernel_class
  → workgroup class count
  → recursive exclusive prefix scan
  → class range/indirect args
  → ShadeWork scatter

consumer:
  fixed MaterialKernelClass[7]
  → seven bounded drawIndirect commands
  → one specialized Surface render pass
```

`VisiblePixelClassifier` 是 count/scan/scatter buffer 的唯一 owner；resize 按 framebuffer pixel capacity 重建，旧 buffer 等待已提交工作完成后 retire。`PackedMaterialResolvePass` 消费 GPU 生成的 indirect args；没有 CPU readback、按材质遍历或逐材质 bind group。Material/Texture 长期资源仍分别由 `GpuMaterialStore` 和 `TextureResidency` 所有，frame-local ShadeWork 不进入 Runtime Asset。

## 冻结 ABI

| Queue/record | 元素 ABI | 容量 | overflow | producer | consumer |
|---|---:|---:|---|---|---|
| group class count | `u32` | `ceil(width×height/256) × 7` | 编码前由 adapter binding limit 拒绝 | count pass | recursive scan |
| scan scratch | class-major `u32` levels | 逐层 `ceil(N/256)` 到 1 | 编码前由 u32/adapter limit 拒绝 | scan level | parent-prefix add |
| `ShadeWorkQueue` | 4 B linear pixel index | `width×height` | 每类 `overflow` counter；任何越界均不写 | scatter pass | specialized vertex shader |
| class state | 16 B `{count, offset, reserved, overflow}` | 7 | 固定容量 | prepare/scatter | indirect draw/counter publish |
| draw indirect | 16 B WebGPU draw args | 7 | 固定容量 | prepare pass | `drawIndirect` |

每个合法、已发布 direct VisibilityKey 只按其 resident MaterialRecord 进入一个 class。invalid/empty/key-to-unpublished-work 不进入队列；未知组合进入 `GenericStandardPbrFallback`，不得静默丢像素。class count 的总和不得超过 framebuffer pixel capacity；运行时 overflow 由 `shadeWorkOverflow` 进入采样证据并使 Gate 失败。

## 保留的不变量

- direct VisibilityKey 先验证 OPAQUE/MASK published range，再读取 exact RasterWork；
- count 与 scatter 使用相同的 key/material/class 判定；
- global atomic 仅按 workgroup/class 聚合，scatter 不做 per-pixel global append；
- prefix scan 为 class-major exclusive scan，任意 block 数递归到根并向下加父级 prefix；
- 材质数量不增加 draw、dispatch 或 pipeline class 数；
- UV0/UV1/UV2、KHR texture transform、normal scale、ORM、emissive、unlit、analytic gradients 和 motion convention 延续现有 oracle；
- GeometryRecord 直接保存 canonical descriptor，Material Resolve 不扫描 stream semantic；
- Velocity 无消费者时没有 attachment，pipeline override 删除 motion 计算，Surface 为 22 B/pixel；有消费者时保持既有 26 B/pixel ABI；
- feature-off 不保留 Velocity Pass、attachment、history、readback 或独立 submit。

## OEngine / WebGPU 差异

- The Forge 的 native descriptor/command-buffer/MDI 模型没有移植；WebGPU 使用固定七次 `drawIndirect`，其中空 class 的 vertex count 为零。
- scan 使用 256-thread shared-memory Blelloch block scan和递归 block sums，不依赖 subgroup 或跨 workgroup 自旋。
- count/scatter 在一维 workgroup 数超过 adapter 上限时使用有界二维 dispatch，并由 `num_workgroups` 还原线性 group；容量超过二维上限时在编码前拒绝。
- resolve 使用 point-list 将 `ShadeWork` 的线性像素定位到 pixel center；fragment 复核 key、work、instance、geometry、meshlet、triangle、material 和 kernel class 后才写 Surface。
- shader specialization 通过 pipeline override 固化 class 与 Velocity presence，generic fallback 只承载未覆盖组合，不允许替代常见 class。

## 性能假设与 Gate

预期收益来自：删除每像素 `find_stream`；只处理非 empty 可见像素；常见材质 class 的纹理/normal/ORM/emissive 分支在 pipeline specialization 后可消除；Velocity feature-off 减少 4 B/pixel attachment 写入和 motion ALU。新增成本是两次 framebuffer key 扫描、递归 scan、ShadeWork 4 B/像素上限、固定七次 indirect draw 与 class state。

必须用同 commit、同分辨率/DPR/画质、相同 warm-up/cadence 的 Dungeon 与 dense paired artifact 报告 classification count/scan/scatter、各 class resolve、总 `classification + Material Resolve + Surface`、visible/empty/class pixels、overflow、Surface bytes、CPU、GPU、显存和 WebGPU diagnostics。目标 `P50 ≤ 5.00 ms` 是停止预算，不是本文宣称的结果；不达标时按实施文档拒绝架构，不恢复旧 fullscreen 双路径。

## 本地回归与未完成项

已覆盖：class mapping、容量/adapter limit、exclusive-scan CPU oracle 的 0/1/255/256/257/65537 边界、direct key validation、无 per-pixel global append、固定 indirect class 数、无 material-count loop、canonical descriptor、UV gradients、Velocity feature-off 资源缺席/22 B、counter ABI 和 shader source audit。

待调用方实机执行：浏览器 WGSL compilation/validation、point-list pixel coverage、resize/render-scale/camera-cut、Dungeon/dense/alpha/UV 场景截图与数值对齐、timestamp/memory paired Gate、device-lost 和 in-flight release。未完成前状态保持 `Gate pending`。
