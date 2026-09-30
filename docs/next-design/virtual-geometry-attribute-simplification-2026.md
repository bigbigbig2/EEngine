# Virtual Geometry：性能优先的几何与材质属性联合简化

状态：**设计提案，尚未替换生产算法；v3.3 为未完成实验。** 研究日期：2026-09-30（本机 Asia/Hong_Kong）。适用当前 static PBR Geometry Product；动态变形与位移另行定义。

## 1. 决策与问题边界

采用方向：在 Native/WASM 共用 Cooker 中，以固定版本 meshoptimizer 的属性感知边折叠为基础，允许受约束地联合更新位置和属性；在实际 meshlet/page 预算内生成粗级。GPU 保持现有 traversal → visibility → surface 单生产路径。

性能优先是验收条件：粗级必须真正减少执行工作，不能靠固定细 LOD、抬高误差或增加常驻预算遮盖损坏。计算发生在 Cooker 不等于没有代价：浏览器首载、WASM 峰值内存、顶点重复、页面流量均需计量。

近景强制粗级允许轮廓变粗，不要求与细级逐像素相同；在相近几何预算下，不能出现跨面属性误配、材质身份错误、非预期破洞和切线失效。

### 已验证事实与未知项

- `GeometryCooker.cpp::SimplifyGroup` 先调用 `meshopt_simplifyWithAttributes`，减面不足时进入 sloppy；原 donor 的 sloppy 仅处理位置与 Lock，不消费法线/UV/颜色，也不把 Protect 当 Lock。代表位置索引曾同时决定完整属性。
- 原窗墙粗级 70 个三角形记录到 72 个反向角点法线，细级为 0；Material ID 没有串域。这解释了已复现的一类黑块，不等于所有残余异常均已归因。
- v3.2“含接缝就拒绝 sloppy”保留了过多细级，已否决并从实现中移除。
- v3.3 实验把 surviving source corners 的属性附着到聚类位置，重新去重，恢复了多级减面；六个 primitive 的反向角点检查通过。但同近景的桶体仍明显损坏，UV、拓扑与切线空间没有完整保证。
- `.codex-temp/dark-lod/v33-near-fine.png` / `v33-near-coarse.png` 是同相机旧实验；fine timing 仍在精化，不能作稳定性能基线。后续必须补桶体特写。

## 2. 来源与采用范围

先读完整算法源码，再读论文与详细技术材料。阶段映射见 [迁移账本](../porting/next-renderer.md#vg-appearance-candidate-2026)。

| 来源 | 固定身份与阅读入口 | 采用范围 |
| --- | --- | --- |
| [meshoptimizer][S1] | v1.3，`9e1f07b159d3cb777f1c67ed31fc11fd117986f4`，MIT，2026-09-25；`src/simplifier.cpp`、`demo/clusterlod.h`、`gltf/mesh.cpp`、`src/tangentspace.cpp`、README | **候选 donor，未采用**。本地干净 checkout 已核对；clusterlod 仍有 position-only sloppy，不能整套照搬后声称修好 |
| Nyx | `bc7e5b1e51f6b3b8af4771db81ffaa714fcbe64b`，MIT；`MiniEngine/Model/MeshletBuilder.cpp` 与附带 meshoptimizer 0.25 | 当前层级/producer 基线；v3.3 source-corner adapter 是本地实验 |
| [Garland & Heckbert 1998][S2] | *Simplifying Surfaces with Color and Texture using Quadric Error Metrics*；原论文属性量纲与颜色/纹理例子 | 属性误差理论依据；不是可直接套用的本项目权重 |
| [Hoppe 1999][S3] | *New Quadric Metric for Simplifying Meshes with Appearance Attributes*，原论文 §3–4 | 多属性与几何误差的组织方式；法线是受约束方向，不能把任意求解向量直接当单位法线 |
| [Epic Nanite 技术文档][S4] | Lerp UVs、Explicit Tangents、Faceted and Hard-edge Normals | 工程参考：可插值 UV 与离散索引不同；硬边有顶点开销；显式切线有存储代价。不是开放许可证完整 donor |
| [Kapoulkine 2024：Meshlet triangle locality matters][S5] | meshoptimizer 作者技术文章，2024-04-09 | 重建后看局部性、重复顶点与执行成本；文中硬件性能不能当 WebGPU 证据 |

研究限制：Nanite 2021 原演讲 PDF 本轮返回 HTTP 406，没有引用未读幻灯片；独立 MikkTSpace 仓库此前抓取失败，未虚构 revision。切线候选使用已固定 meshoptimizer 的 compatible 模式，并验证源资产烘焙约定。

## 3. 数据路径与所有权

```text
GLB accessors + material description
  → canonicalizer / native importer
  → canonical material domains
  → Native/WASM GeometryCooker
      active topology + attribute wedges
      → boundary constraints → joint simplification
      → normalize / tangent policy / compact / rebuild meshlets
      → packed-cost acceptance + bounds + error propagation
  → Geometry Product pages / residency
  → GPU hierarchy SSE + refine handoff
  → VisibilityKey + depth
  → Surface: position / normal / UV / tangent / material
  → lighting / temporal / presentation
```

实际入口：`examples/demos/14-integrated/next-renderer-showcase/main.ts`；`OEngine/src/assets/web-cook/gltf/GlbPrimitiveCanonicalizer.ts`；`OEngine/tools/oengine-asset-core/src/geometry/GeometryCooker.cpp`；`OEngine/src/shaders/hierarchy_lod.ts`、`virtual_geometry_work.ts`、`surface_material_kernel.ts`。Surface 只能插值当前粗三角形属性，不能还原 Cooker 已丢失的原表面对应关系。

| 边界 | 拟修改 | 不变量 |
| --- | --- | --- |
| canonicalizer / asset-core（路由 primary owner：platform） | 材质属性使用描述、可信共享边界，Native/WASM 相同输入 | Loader 不持有长期 GPU 资源；同输入同 recipe 可复现 |
| Cooker | 活跃 wedge、联合简化、后处理与成本验收 | 细级不可变；失活的历史 wedge 不参与本级接缝判定 |
| Product / residency | recipe/缓存失效，正确 bounds | 初期保持 GPU 顶点格式；容量、引用和生命周期有效 |
| GPU traversal / Surface | 原路径消费正确产物；验证所需诊断 | 无本帧 GPU→CPU→GPU 可见性控制，无额外 frame submit |

当前 `MaterialDomain` 仅有 ID、flags、attributeMask、顶点、索引，**没有完整材质使用描述**。纹理尺寸/变换/UV 集等输入须以有界 cook-only descriptor 贯通 Native/WASM；不能假装已经可用。若改 canonical ABI，显式升版并成对重建 WASM/glue，不伪称仍沿用 ABI-v2。

## 4. 几何位置、属性 wedge 与边界

同一位置可有多个属性 wedge，即不同法线/UV/切线的角点记录。位置邻接和完整顶点去重分别处理；不能按位置焊接属性。只在可信拓扑/域范围建立对应，不把重合但互不相连的薄壳当同一表面。

| 数据/边界 | 处理 | 理由 |
| --- | --- | --- |
| Group 外边界 | 相关 wedge 一致 Lock；位置和锁定属性逐 bit 保持 | 相邻不同 LOD 不能裂开；不扩散到全部内部顶点 |
| 材质域交界 | ID 是离散身份；共享界面两侧同步保持 | 独立域不能各自漂移。跨域对应缺失时保留可识别的外边界，报告减面限制 |
| UV chart / 镜像分界 | 保留 wedge 与方向，用明确 Protect/chart 约束 | 防止跨图表误合并；仍允许图表内部减面 |
| 普通硬法线 | 受权重控制的外观误差，不整组冻结 | 大平面、小倒角要能简化；有意硬边的损失仍需评估 |
| UV0 / UV1 | 所有被消费 UV 同步更新，不任意取模 | 位置移动而 UV1 不变会形变；repeat、atlas、镜像不同 |
| 顶点颜色 | 实际消费的连续通道参与误差，保持颜色空间合同 | 离散 ID 不能平均 |
| tangent.w / feature ID | 保留或重建离散符号，不线性平均 | 镜像切线方向不能取得中间值 |

Protect 与 Lock 不同：前者配合 permissive 的接缝规则，不能让 sloppy 支持属性。非流形或缺可靠邻接的数据需给出具体失败原因。

## 5. 核心算法与有界候选

固定 v1.3 的 `meshopt_simplifyWithAttributes` / `meshopt_simplifyWithUpdate` 为候选核心；后者允许求解新位置和属性。保留 donor 的 quadrics、wedge 分类、边折叠、翻转/更新约束与输出阶段，不另写缩水 QEM。

外观目标示意：`E = Eposition + wN·Enormal + wUV0·Euv0 + wUV1·Euv1 + wC·Ecolor`。这只解释目标，**不替代 donor 公式**。权重由固定 recipe/cook descriptor 生成，不能把角度与 UV 偏移直接当米。

UV 权重考虑材质槽、UV 集、纹理分辨率和线性 UV 变换，使用有上限的归一化 profile；平移影响取样内容但不放大梯度。Normal-map/alpha-mask 单独验证。该度量是外观重要性的近似，不是真实纹理采样误差或严格 texel 上界。缺元数据使用可审计基础 profile，不能标记材质感知已生效。

### 5.1 单组步骤

1. 从本级活跃索引收集局部数据；仅焊接完整、确定相同的记录，建立边界。历史 LOD 池不参加本级 seam 判定。
2. 先生成不移动顶点的属性感知候选。减面目标先沿用现 recipe 的 0.5，这是目标，不是任意模型的保证。
3. 不满足质量/减面/产物预算时，从原组局部副本执行一次 WithUpdate；锁共享界面，更新全部所需连续属性。最多两次主简化，不无界搜索参数。
4. 按边界分类配置 permissive；PreserveFolds 可评估薄壁用途；ErrorClamped 默认不启用。二者在该版本都是 experimental，不能视作正确性证明。
5. 规范化、切线处理、去重、重建 meshlet 后才比较实际代价。两种候选是同一 Cooker 的构建策略，不形成两条 runtime 路径。
6. 无合格候选则记录原因与达成预算。局部层级可合法终止，但**不能据此声称修复完成**；桶/墙若仍大量停留细级，性能目标尚未满足，须继续修 producer 或单独设计资产 proxy。

主方案切换时删除 `MeshoptimizerSloppy.*` source-corner adapter 及编译包装；材质保真 profile 不再进入 position-only sloppy。须以能继续减面的联合优化替代它，不能仅关回退留下冻结。

### 5.2 属性与切线后处理

- 细级不可变，粗级在暂存区生成；只提交被接受候选，拒绝项不累积孤立顶点。
- 法线归一化；退化/非有限向量是无效候选。几何法线与着色法线不必相等，单个点积检查不能证明外观正确。
- 需重建显式切线时，使用粗位置、更新法线、normal-map 对应 UV，调用固定 donor 逐 corner tangent 生成并按断点重索引。源烘焙为 MikkTSpace 时评估 `meshopt_TangentCompatible`。
- 共享边界的已锁定属性不得被后处理改写；边界切线作为一致约束保留，内部重建，并验证混合 LOD 接缝。独立按组重算不自动保证连续。
- 原本没有 tangent 流且 Surface 使用 UV 梯度构造切线的资产，先维持原 ABI，不无条件增加字节；验证镜像/UV 变换/退化的现有路径。
- 重建切线不保证激进粗化仍完美匹配原高模烘焙。多套 normal-map UV 超过单切线流能力时，沿现有逐槽合同处理或明确未支持，不能套错 UV。

## 6. 误差、bounds 与 GPU 消费

- 粗顶点能移动后，重算粗 meshlet 球/AABB，再合并 refinement descendants。当前 `CookDomain` 直接以子组 sphere 覆盖新 sphere 的代码必须修改；粗几何和后代都要被界覆盖。
- 当前 `parentError = max(newError, childError × lodErrorMergeFactor)` 是 Nyx 集成策略，不是已证明的累计表面误差上界。保留 donor 真实单位，不 clamp 属性误差使坏粗级提前出现。
- 先沿已核验 scalar SSE 语义保证单调；为 WithUpdate 建分层误差 oracle，传播不足则显式修改 recipe。权重与 absolute 归一化须贯通全链，不把法线角度或 UV 偏差直接投影成米。
- 几何误差与法线/UV 诊断分别写 cook evidence。独立 runtime appearance SSE 属另一项 ABI/性能决策，本设计不增加每帧属性修复。
- 保持 coarse `<= SSE` / fine `> SSE`、resident refine gate、缺页 coarse 保留；不因局部缺页锁住全模型。

## 7. 性能验收与失败条件

候选至少比较 `triangles, meshlets, packed vertex bytes, decoded page bytes, padding, bootstrap bytes`。去重、重建与页面打包后才接受粗级，不能只看 index count。

| 范围 | 要求 | 失败例子 |
| --- | --- | --- |
| 同组父子 | 三角形减少，meshlet 工作潜力减少，顶点/页开销受同预算限制 | 减面后拆成更多 meshlets；复制大量顶点保法线 |
| 整资产 | 同 bootstrap/resident/streaming 容量，计全部 LOD 字节 | 把 Cooker 共享顶点误当页面共享；本项目页面已有局部重复 |
| 首载 | Native/browser WASM 各自记录 wall time、峰值内存 | 无界重试、逐级扫描历史 wedge 导致膨胀 |
| 稳定帧 | 同设备/分辨率/实例/灯光/效果/驻留，GPU P50/P95 无可复现回退 | 依赖更多细级或新着色 pass；只看 FPS 文本 |

无数据不承诺零开销，不捏造性能百分比。原始有黑块但能减面的版本是性能对照，冻结细级版本仅为诊断负例；比较相同工作预算与正常自动 LOD 两种情况，不能只调 SSE 改变工作量。

预算与质量不可兼得的资产产出具名失败报告，不静默加预算。Topology remesh + 属性重投影/贴图重烘焙可另研究，但涉及新 atlas、纹理/页内存和首载成本，不作本轮默认回退。

## 8. 验证与实施

### 必要证据

- 固定 donor vs adapter：位置、索引、属性、locks、单位、确定性；Native / single WASM / pthread 对齐。
- 覆盖跨组/跨材质边界、镜像/双 UV、法线贴图、硬边、薄壁、alpha-mask、低 roughness 和颜色面；检查退化、绕序、材料 ID、bounds、误差、terminal/refine。几何检查不能代替材质画面。
- 桶/墙异常拆解为 base-color-only、几何/着色法线、normal-map on/off、UV/checker、剔除覆盖；未实现的 debug 菜单项不能当证据。
- 等精化/上传/residency 稳定后保存相机、对象、SSE、recipe/hash；**同一桶体/墙体特写只切粗细 LOD**，对象占足够像素，不用全景替代。允许轮廓变粗，不接受属性串面。
- 同相机看 meshlet/triangle 变化及有效计数；正常近/远自动选择验证 handoff。远景会增加可见对象，必须按同对象比较。
- 性能另行预热，多轮完整 GPU timestamp history，报告 P50/P95 与噪声；同时报告页面字节、三角形和 emitted meshlet work。未接通的 0 计数不是成果；诊断 readback 不进生产控制链。

### 实施顺序与切换

1. 拆解桶体残余异常，补属性使用/边界输入，固定 donor、recipe、CPU oracle。
2. 接属性感知 + WithUpdate 有界候选、后处理和成本验收，修 bounds/误差消费，删除 source-corner sloppy 实验。
3. 重烘焙缓存与两套 WASM/glue，集中 typecheck/build/targeted tests；同步记录 cook 成本，不建旧/新生产桥。
4. 做特写与稳定性能对照；通过前保持“候选验证中”，不因构建通过提升采用状态。

本轮只研究、设计并纠正文档，没有实施 v1.3 替换。此前 v3.3 Native/WASM 构建、18 项 targeted tests、typecheck/build 通过，但桶体视觉未通过、稳定性能未验收；旧测试不证明本设计已实现。原型仍留在工作区，未提交。

[S1]: https://github.com/zeux/meshoptimizer/tree/9e1f07b159d3cb777f1c67ed31fc11fd117986f4
[S2]: https://www.cs.cmu.edu/~garland/Papers/quadric2.pdf
[S3]: https://hhoppe.com/newqem.pdf
[S4]: https://dev.epicgames.com/documentation/en-us/unreal-engine/nanite-technical-details
[S5]: https://zeux.io/2024/04/09/meshlet-triangle-locality/
