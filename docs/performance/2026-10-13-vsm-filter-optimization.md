---
id: performance/2026-10-13-vsm-filter-optimization
state: history
---

# VSM 采样与 Bias 优化实施记录

用户授权按已讨论顺序实施，并接受滤波质量取舍。本单元替换生产滤波核、接入噪声、删除准确零贡献工作并整理 Bias；没有改 Geometry frontend、VSM 页面管理/raster 或 AMD Temporal/FSR 算法。当前单元状态只在 [V5 执行计划 §8.3](../next-execution/eengine-v5-final-pixel-performance-execution-2026-10.md#83-vsm采样与bias优化2026-10-13) 维护。

## 1. 实际切换与退休

- 默认 `disk4`：四点等面积 Vogel 圆盘，实际半径 1.5 shadow texels。四点在 CPU 预计算；每个有效接收点复用一次查询、位置投影、旋转和地址基址。
- `gather2x2`：一次 raw depth gather、四个独立比较后双线性加权；固定小核，无噪声。`point`：一次深度读取。半径零的圆盘在 CPU 折叠为 point，既不分配噪声段，也不增加 shader 判断。
- 保留反向深度的 `stored == 0` 空值和负接收参考深度语义；不使用会改变这些语义的裸硬件比较替换。
- 原位置是 texel 边界坐标，raster 样本位于 integer+0.5。新 point/disk 选择 `floor(receiver+offset)`；gather 以 `receiver-0.5` 定位并插值。逐采样平面修正使用实际读取 texel 的中心，包含取整与 gutter clamp，不能只用理想圆盘偏移。
- Native 在 PCF 前检查已有 `DirectPhysicalResponse`，普通 lobe 和 clear coat 都无贡献才剔除；不根据几何法线单独剔除。完全遮挡后跳过太阳辐照度的既有优化保留。
- Normal/Slope 两个重复角度项合并成诚实命名的 `angularBiasTexels`；没有伪称实现沿法线的位置偏移。新默认 Depth=1、Angular=1，以 actual level/mip texel 和 inverse depth range 缩放。
- 基于已恢复的几何法线计算一次光空间接收面梯度。对 `n.x dx+n.y dy+n.z dz=0` 和 reverse depth，梯度为 `n.xy/n.z * depthPerTexel`；每次比较按实际样本中心修正参考深度。极端 edge-on、无法有限表示 z(x,y) 的面保留有限比较 Bias。没有邻居 geometry resolve、额外 buffer/pass/history。
- 删除生产 4×4 循环、旧重复 texel 特例、`pcfTapsPerAxis`/`pcfTapCount`、Normal/Slope 调参和无消费者的 `ShadowContract.ts`。Dungeon、Bistro 控件/状态/说明及性能 runner 同步切换，旧参数明确拒绝。
- 老采样器仅冻结在 oracle fixtures，固定于实施前 `fdba34b6531efb33a1cdf3a4faa9d4d8956ed716`；旧 S3 reference 改为引用冻结版本，不把新核塞进历史 golden。旧 PCF 表示一致性测试移交独立新数学 oracle；完整 query/status/identity 断言继续逐字比较，没有省略必需的新语义。

## 2. 噪声与所有权

复用既有 `stbn_vec1.bin`：128×128×64、uint8 单通道，原始 1,048,576 字节全部保留，不截短序列。完整数据加 256 个 f32 rotation pair 共 1,050,624 字节。离线全序列 FFT 观察空间低/高频平均功率比 0.070710、时间低/高频比 0.094310；这是资产特征检查，不证明最终时域画质。

CPU loader 不持有 GPU 对象；加载失败明确报错并支持重试。Renderer 作 composition root，VSM 拥有逻辑噪声段，`FinalPixelLightingPublication` 管物理 fenced allocation。tail 位于完整 local lookup 后，descriptor/Solar/local producer 的写域不变；Native 复用 lighting binding 和 sampling constants 的保留字段。创建 allocation 时上传一次，稳定复用不上传整份噪声；AA-on 按成功提交 frameIndex 的 64 相位取值，AA-off 固定相位零。

容量在创建前检查；最多三个 submitted/prepared allocation，噪声最坏新增 3,151,872 字节（约 3.01 MiB），每帧热工作集约一个 16 KiB slice 加 2 KiB rotation table。point/gather/零半径/无 VSM 不分配该 GPU 段。提交保留到最后 consumer fence，abort 可复用未提交候选，切换/resize/empty/device loss/销毁退休；没有独立 submit、纹理或 storage binding。

## 3. Cost Card 与未采用项

| 成本 | 旧默认 | 新默认 |
| --- | --- | --- |
| 深度采样指令/有效 receiver | 16 loads | 4 loads |
| 原始逻辑读取/receiver | 64B depth | 16B depth + 12B packed-noise/rotation reads |
| 查询/位置投影 | 一次 | 一次，零贡献在它之前退出 |
| 新 ALU | 无接收面修正 | 一次 normal 投影/除法；四个小 dot 与 reference add；共用地址 setup |
| 新 atomics/barriers/dispatch/pipeline/binding/history | — | 0 |
| 稳定上传 | 既有 constants/publications | 相同；噪声为 0B/frame |

这些是逻辑指令/读取量，不能当 DRAM 字节。缓存、coalescing、分支分歧及编译器 lowering 影响真实成本。按准确零贡献剔除比例 0/50/100%，剩余名义 depth loads 为 4/2/0，噪声 reads 为 3/1.5/0；混合 wave 的实际收益低于理想值。100% 剔除仍有已有材质/BRDF及小判断成本，不宣称整段 Native 免费。

固定四点没有额外两点预探测。两点同亮/同暗不能证明完整核没有细阴影；额外 probe 再执行四点的名义 `2+4p` 只在 p<50% 才有读数 break-even，且尚未计分歧/错误分类。准确零贡献、无效页和零半径剔除已经完成，不留半影猜测 placeholder。

VSM 深度、寻址、矩阵、梯度/Bias 保持 f32/u32。设备默认不自动请求 `shader-f16`；单改 ALU 类型不会缩小 depth32float 读取，4096 atlas 的 half UV 精度也不足。四点可见度仅一个累积标量，不为未证明的寄存器收益新增 feature/变体。f16 审查完成，本单元不采用。

## 4. 验证与原失败

最终集中验证包括 engine typecheck/build/declarations、fresh build:test、Dungeon/Bistro typecheck/build、31 targeted Node；GPU 串行覆盖如下，结果与 error scopes 保存在 `.local/vsm-filter-20261012/`：

- `vsm-filter`：388 配置、595,968 个 CPU/GPU 对照；64 相位、三模式、空/负/相等深度、所有 gutter、单 texel pole、非恒定深度及 NPOT gather。
- `vsm-bias`：768 配置、442,368 个 receiver 检查；旋转光空间、fine/coarse、斜率到 (8,4)、半径 1.5/3、Bias .5/1/1.5/2、self/contact 与 singular guard。修正后的 self failures=0，Bias≤1 保留 2.5 texel contact；79,020 个未修正 acne 和 69,120 个较大 Bias 的 panning 反例保证测试敏感。只证明该解析面域，不能称任意曲面不再 acne。
- `final-pixel-sun-response`：3,600 例与 frozen BRDF 一致，含 1,680 可剔除例、480 coat-only 例、192 HDR finite-guard 反例。
- `vsm-sampling-publication`：所有 query/status、完整 identity、signed boundaries/window roll/dirty/reset；新滤波数学由上述独立 oracle 承担。
- 实际 Native 1080p 四类×256帧 shadow quality，移动/停止、半径/模式/相位；全像素和边界指标保留原门，没有删边界。
- 真 Renderer ordinary/Product、最小 binding 边界、无 Sun/有 authored IBL/ bounded capability、模式/零半径/AA开关、abort/retry/defer/resize/recovery/release。actual uniform、Native binding、噪声段大小/offset/phase 被检查，API release=0。
- 普通示例 1.0/.667 的 idle/rotate/pan/zoom，以及实际下拉框模式切换。`review-closed/report.json` 无浏览器错误，5次模式/半径切换中总计6个lighting allocation、4次噪声初始化、重复上传0、释放后lighting buffers=0。另6项frame-pacing回归通过。截图属于人工局部观察，不能代替长序列 AAA 验收。

原失败均保留并局部修复：首次 gather 的 vec2f 构造漏显式 u32 转换（`filter-first.json`）；Node fixture 漏 GPUBufferUsage（测试装置）；历史 broadcast 拼接新 sampler 签名（`publication-first.json`，冻结 reference）；控件状态仍保留 taps key（`after/interactive/report.json`，实际浏览器失败）；新增 production 检查错读 capture 而不是 actualFrame（`production-first.json`，测试装置）。未吞失败、未放宽容差或加生产 fallback。短诊断 manifest 初次缺 outputs 的工具错误也保留在 `abba-A1/`，随后补实际构建输出 hash，不伪造完整原源码指纹。

## 5. 实际成本与剩余边界

GTX 1650 Ti、Chrome 154、Driver 581.42。独立 1080p sampling cost 含真实噪声 lookup、平面修正和 output 写入，但不含 query/BRDF/raster/Temporal；128 个交错样本保留全部 raw。最终 old16/old4/disk/gather/point P50=.937696/.363280/.262896/.159616/.146368ms，P95=.941109/.364648/.265218/.160848/.147360ms，读取 `vsm-filter-cost-closed.json`。相对16点局部核约降低72%，相对旧四点循环也降低约28%；后者不是完整2048 bounded Renderer性能资格。

四个整链短窗各 96 个完整 GPU samples，暂停至82°C后恢复，保留第一帧。构建指纹是 copied/bundled JS 输出身份，未伪称恢复了完整 baseline 源树；没有 geometry-settled 正式门，因此只是局部成本诊断。

| 窗口 | whole P50/P95 ms | Native winner P50/P95 ms | VSM 管理 P50 ms |
| --- | --- | --- | --- |
| A1 旧 | 17.171840 / 18.483784 | 4.207312 / 4.708208 | 5.079968 |
| B1 新 | 16.397280 / 17.640208 | 3.799760 / 4.266992 | 4.842224 |
| B2 新 | 16.534752 / 17.714744 | 3.819184 / 4.330976 | 4.971760 |
| A2 旧 | 16.475424 / 17.687512 | 4.229968 / 4.711856 | 4.630672 |

Native 两侧 P50 分别少 .407552/.410784ms（约9.7%），P95亦降低。whole 两侧分差方向不一致，VSM管理波动约.45ms；不能把 Native 收益、测试通过或单窗FPS提升晋级为稳定60FPS/完整 VSM 改善。未冷却的 ordinary motion 窗口从1350MHz到300–1050MHz混杂，原 FPS 全保留，不能作精确前后速度证明。

仍未进行 Phase6 的三块≥1000帧正式资格、完整 authored 高覆盖动态影像、所有硬件/浏览器或4GB长窗口驻留。四点噪点仍依赖既有 Temporal 的处理能力，单点模式保留硬边；没有新增专用 shadow denoiser。下一性能重点是尚有约4.6–5.1ms的 VSM demand/管理/raster，需另行定位；本单元没有越界改它。

## 6. 来源边界

本地自主四点公式和 host/GPU接线，非完整 donor 移植。参考固定入口：[Bevy fd980635](https://github.com/bevyengine/bevy/blob/fd98063564218bd210308675602a3e9643014c31/crates/bevy_pbr/src/render/shadow_sampling.wesl)（MIT/Apache-2.0，旋转/PCF）、[Wicked 7f776d02](https://github.com/turanszkij/WickedEngine/blob/7f776d02094571dd2c8166c7e5879d5e93d2b642/WickedEngine/shaders/shadowHF.hlsli)（MIT，disk/dither、f32比较）、[MJP a83ce993](https://github.com/TheRealMJP/Shadows/blob/a83ce99377c7b46f2faecfbd7769726004f4db81/Shadows/Mesh.hlsl)（MIT，ComputeReceiverPlaneDepthBias/RandomDisc/GridPCF）。本地使用实际几何平面，替代 fragment 导数；raw gather 能分别修正四个 texel，避免硬件单 reference 的限制。STBN 复用既有资产，研究依据为 [NVIDIA STBN](https://research.nvidia.com/publication/2022-07_spatiotemporal-blue-noise-masks)，不重新声明原资产 donor adoption/license。
