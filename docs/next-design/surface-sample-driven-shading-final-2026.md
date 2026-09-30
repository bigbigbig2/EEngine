# Surface 可见性驱动分频着色：最终设计

日期：2026-09-30。状态：阶段一至阶段四主链已实现并完成模块级验证；正式浏览器、画质、整帧性能与 claims 验收仍待整体 Next Renderer 阶段。尚无本地净加速或最终画质验收结论。

本文确定 Surface 重构的唯一推荐方向，替代 [前期调查](surface-shading-performance-design-2026.md) 中的候选排序和“先 A/B 小优化”顺序；上位架构仍为 [Next 整体设计](eengine-next-overall-architecture-final-2026.md)。执行顺序见 [Surface 重构执行文档](../next-execution/surface-sample-driven-shading-rebuild-2026.md)，来源/阶段映射见 [Next 来源账本](../porting/next-renderer.md)。

2026-09-30 阶段二直接替换唯一生产主链，阶段三加入 32-bit 分信号率布局。2026-10-01 补齐有限的 material-coarse/lighting-full 精确 closure layout、受限 GPU 邻域重建、workgroup TriangleSetup 的实际消费与真实异步计数：8×8 tile/2×2 cell 的 Work Builder、descriptor/compact workers、整 tile 多池提交、独立 GPU finalize 与不可变 sample results → 目标照明 → Resolve → HDR。受控非恒定 resident albedo Standard PBR 在具名预算下有 material 16 / lighting 64 的实际 GPU 消费；完整 IBL/DFG/energy 和逐像素 AO 的常量 closure 对照逐位一致。默认预算仍严格；local lights、VSM、物理天空/IBL 和变化 AO 只约束 lighting，已证明材质复用可独立保留；未知纹理/normal-map/ORM/Coated 保守全率。默认 Dungeon 的材质与照明样本仍等于有效像素，不能据受控减量证明该场景 adaptive 净加速。Temporal 保持独立 motion，此前 VG 画质问题不因本阶段而关闭。

## 1. 决策：直接改重着色的工作单位

采用具名本地设计 **EEngine Signal-Rate Surface**：以可见性驱动、表面连续性感知的 frame-local shading sample 为重计算单位，减少普通纹理 PBR 的几何属性恢复、材质纹理采样和照明求值次数。

接受删除、重构、Product/发布数据调整、Frame Program 依赖变化和 owner 重新划分。性能优先体现在减少工作、改善有效执行和减少不必要的中间带宽，不以删除正确性检查或任意降低材质模型质量交换性能。

确定以下决策：

1. **首先完成材质与光照联合分频的完整主链。** 不先单独完成 IBL 快路径、BindGroup 缓存或原子微调，也不以只有 Unlit/便宜漫反射降频作为交付。
2. **Visibility/depth/coverage 与 motion/identity 保持内部全分辨率。** 重着色采用 `1×1 / 2×1 / 1×2 / 2×2`，初期 `4×4` 只用于经证明的常量信号；不用全局粗率复制替代复杂 PBR。
3. **连续表面的内部三角形边界允许有条件共享。** Winner identity 与 sharing identity 分离，Product/Cooker 的连续性信息是主线范围；不能永远停留在 same-VisibilityKey 降频。
4. **全率是新架构的正常执行模式。** 允许全屏全率，不假设边界、高频或 Coated 必定稀少。新 full-rate consumer 与 coarse consumer 共用算法语义，不保留旧/新 renderer 运行桥梁。
5. **材质与光照采用逻辑上独立的 rate。** 物理上优先融合同率的材质与照明；不同率确有节省时才物化紧凑字段，避免先创建全屏大 GBuffer。
6. **代表工作按需压紧，保留 tile/cluster 局部性。** 不把所有有效像素无条件转换成大像素队列；纯 full-rate 与纯 uniform-rate tile 可隐式寻址。
7. **TriangleSetup 是按需求共享的内部优化。** 不把现存 `LargeTriangleSetupCache` 无条件升为全部 Surface 的前置依赖。
8. **空间主线先闭环，缓存后续独立演进。** 首版无需跨帧颜色缓存；后续优先评估稳定材质属性或 irradiance，完整 view-dependent radiance 不作为首批缓存。

首个完整范围是当前可见性主链中的 rigid opaque Standard PBR；Unlit、Coated、alpha-mask 及未满足降频条件的现有材质必须在同一新架构中保持可用，按信号或整 sample 全率执行。透明的多层覆盖/合成属于独立 composition domain，不能塞进单 winner 的 opaque full-rate exception 解决。

## 2. 源码基线与实际问题

本次基线为 `f4c2127a`，工作树已含前期设计与来源记录改动。源码是当前事实，以下文档路径或符号用于实现导航；行号变化时以符号为准。

| 当前事实 | 已核对入口 | 对本设计的含义 |
| --- | --- | --- |
| Probe 后由 tile Work Builder 选择 full/coarse/mixed 工作，worker 与 Resolve 使用同一 Surface 数学 | `OEngine/src/render/surface/SurfaceMaterialPass.ts::addToGraph`；`OEngine/src/shaders/surface_sample_work.ts`、`surface_sample_worker.ts` | 维护固定 tile state、有限 profile、不可变 sample results 与整 tile fallback |
| signal-rate 由 Probe 发布并由 Builder/worker/Resolve 共同解释 | `OEngine/src/render/surface/SurfaceSignalPlan.ts`；`OEngine/src/shaders/surface_probe.ts`、`SurfaceSampleAbi.ts` | 方向性 material/lighting/emissive/normal rate 取保守交集；未知和高频信号保持 full-rate |
| Surface 不再生产 motion；Resolve 只读取不可变 coarse results 与 visibility/depth 边界 | `OEngine/src/render/temporal/TemporalFactsPass.ts`、`OEngine/src/shaders/temporal_facts.ts`、`SurfaceMaterialPass.ts` | TemporalFacts 独立拥有 motion/identity；Resolve 不读写 HDR 同一写域 |
| PBR 每 sample 解码三顶点、投影、重心、法线/UV、纹理和照明 | `OEngine/src/shaders/surface_geometry.ts`、`surface_material_evaluation.ts`、`surface_lighting.ts` | full/coarse/fallback 共用材质与 radiometry 语义 |
| 固定 tile state、record/result pool 与二维 indirect 在创建前按 device limits 收敛 | `OEngine/src/render/surface/SurfaceSampleAbi.ts`、`SurfaceMaterialPass.ts` | pool overflow 退回整 tile full-rate；不依赖 repair queue 或 CPU 本帧读回 |
| 现存大三角形 setup 使用普通 Geometry/Meshlet ABI | `OEngine/src/shaders/large_triangle_setup.ts::build_large_triangle_setup` | VG 需要自己的正确 Product 恢复；不能声称现成缓存已支持 |
| VisibilityKey 编码 frame-local MeshletWork slot | `OEngine/src/gpu/GpuVisibilityKeyAbi.ts` 文件契约 | 不能直接作为跨帧 shading cache key |
| Temporal 已有几何/材质签名与 rigid previous mapping | `OEngine/src/shaders/temporal_facts.ts::geometry_signature/previous_clip_for_surface` | 改现有权威链路，不新建互相竞争的 motion/identity 定义 |
| current-HZB late recheck 已有条件接线；VG previous-HZB rejection 主动禁用等待 recovery | `OEngine/src/render/program/FrameProgramLowering.ts::lowerVisibility`；`render/passes/PackedVisibilityPass.ts` | 保留上游独立边界；不把减少被遮挡候选误算成同比减少最终像素 |

9 月 25 日报告属于旧 revision/设备条件，且有温控与交互因素，不能作为当前各算子耗时或本设计收益预测。没有实测支持“必降 40–65%”“再降 30–70%”等区间。

## 3. 成本目标与完成含义

令 P 为有效可见像素；S_M、S_L 为实际重材质与照明样本数：

```text
当前：轻量遍历 + P × (几何恢复 + 材质 + 照明) + 调度/写回
目标：P × 轻量事实/分类
    + S_M × 重几何/材质
    + S_L × 照明
    + 必须全率的信号 + 队列/中间字段/重建/写回
```

普通贴图 PBR 的 `S_M/P` 和可降频照明的 `S_L/P` 必须真实下降，同时总 Surface 依赖子图时间下降，才是性能成功。只是队列变小、dispatch 名称变 sparse、仅 Unlit 命中或把成本移到 classifier 都不算。逻辑样本减少也必须体现为更少有效重 shader 工作，而不是在每个 wave 中留下少数活跃 lane。

全分辨率事实和最终输出仍为 O(P)。例如 80% 像素的某条重路径允许 2×2、其余全率，相关样本量为 `0.8P/4+0.2P=0.4P`；该算例只表示少 60% 样本，不表示 Surface/整帧快 60%，也不预测当前场景的可合并比例。

画质策略使用可配置的、具名的信号误差预算。没有证明时不能宣称 bit-exact 或“绝对无损”；预算覆盖颜色、法线方向、粗糙度、亮度/高光与时域稳定性，不以一个 roughness 阈值替代全部判断。具体数值由受控内容与目标设备收敛，本文不捏造阈值。未知证据有完整 full-rate 行为，但真实目标场景全退回 full-rate 说明主线尚未完成性能目标。

## 4. 目标数据流与物理执行

```text
Geometry/Product + Material/Texture Publication
       │ 连续性、代际、采样路由、变化风险
       ▼
VisibilityKey / depth / coverage / MeshletWork
       ├─► Pixel Facts：逐像素 motion / identity / validity
       │
       └─► Surface Work Builder
             ├─ 纯 full-rate / uniform-rate tile：隐式工作
             └─ mixed tile：代表样本、mask、有限 lane 计数
                         ▼
                GPU finalize / bounded indirect
                         ▼
          需求驱动几何 probe/setup + Material/Lighting Workers
             ├─ 同率融合，常见热点尽量留寄存器
             └─ 异率时仅物化被消费的 compact signals
                         ▼
              Surface Resolve / 高频信号合成
                         ▼
          full-resolution pre-exposed HDR + demanded fields
                         ▼
           现有 Environment / Temporal / FSR3 / Bloom / Present
```

这是逻辑阶段图，不要求每个方框固定一个全屏物理 pass。既有后处理的实际依赖和先后仍由 Frame Program 降级为 FrameGraph；不照图强行重排 Bloom/环境合成。所有阶段使用现有 command context 和唯一 submit owner。

首选执行组织：8×8 为基础空间 tile，内部以对齐 2×2 cell 作 rate 决策；支持方向性的半率。workgroup 的初始核心实现用现有 64 invocation 量级和 workgroup memory，后续只在测量支持时改尺寸。多材质 tile 可含多个 mask；tile 本身不是材质或采样率一致性的证明。

## 5. 表面身份与发布数据

本节定义语义，不冻结字节布局和正式 ABI。新字段稳定后再写入 `docs/specs/` 或 `docs/contracts/`，CPU/WGSL 布局保持单一事实源。

| 信息 | 生产 owner | 消费与有效期 |
| --- | --- | --- |
| Winner identity：key、queue generation、实例、primitive | geometry/visibility | 当前帧精确访问几何；禁止跨帧直接缓存 key |
| Sharing domain：实例 + Product 内连续表面域 + material + representation/generation | geometry Product/Cooker 与 GPU publication | 当前帧判断允许共享的候选边界；不等于结果相同或跨帧稳定 chart |
| Continuity/risk：UV/顶点属性/normal/tangent 接缝、朝向、局部变化界 | Cooker/Product，运行时转换必要的空间信息 | 缺失、过期或不匹配时相应信号全率 |
| Material sampling signature：role、UV set/transform、sampler、色域、texture generation/residency | materials-textures | 分类/probe 与真实采样必须同一发布快照 |
| Variation metadata：常量证明、按 mip 的颜色/参数区间和法线变化范围 | 资产处理与 texture publication/residency | 与实际 decoded texture、wrap/filter/LOD 语义匹配；普通平均 mip 不是范围证明 |
| Frame-local sample identity：代表坐标/footprint、signal group、lane、sharing domain | Surface Work Builder | 仅本帧 worker/resolve；不同信号可以不同 sample ID |

Cooker 在源拓扑上按材质与不连续边划分 domain，并在各输出 LOD 的实际角点/属性上验证或重新划分；不能把原 meshlet ID 当 domain，也不能盲目传播一个跨接缝的 connected-component 标签。简化跨越边界且无法保持属性一致时，为输出 primitive 发布不可跨域共享标记；不要为了共享而恢复第二套几何表示。

跨 primitive cell 必须同时满足同实例、合法连续性、compatible material/texture route、当前代际、当前深度/朝向风险等条件。UV 连续并不等于低频，几何平滑也不等于 normal map 平滑。同一个 domain 内仍需检查本 cell 的变化。非均匀缩放、镜像、双面朝向、UV wrap/接缝、顶点色和退化必须进入风险或拒绝条件。

Product/pack 如果新增必要布局，使用一次明确版本/recipe 切换和 recook，更新 Native/WASM/运行时消费者，不在生产中长期保留新旧双解析器。概念上可缺省的风险字段用全率语义处理，但不能靠所有资产缺字段将主线退化成永久全率。

## 6. Surface Work Builder：分类不能先支付完整 PBR

### 6.1 分级判定

每个 tile 的轻量入口读取 key/depth、已验证的 work/material/instance 信息；背景、非法 key 和明显 full-rate 的域尽早分类。publication 能证明恒定或某 family 不允许粗率时，不再执行昂贵 variation 分析。默认只读取可见赢家，不遍历所有候选 meshlet 的每个 primitive。

对仍可能受益的 2×2 cell，按以下顺序判断：

1. **Coverage 与身份。** 有效像素、同实例与共享域、相同材质采样语义、当前 generation；不跨真实轮廓，不混合 opaque/alpha-mask/background 或不同 composition domain。图像右/下尾部明确退成可覆盖的小 rate 或 full-rate。
2. **几何连续性。** 比较从 depth 恢复的 view/world position 与视距相关的连续性预算，结合 Product 提供的法线/属性范围；不采用固定设备 depth 差作为所有距离的规则。跨 primitive 必须有 continuity 信息。
3. **材质变化。** 先用已发布常量/粗粒度变化界；若不足，仅对候选 cell 做受限 `SurfaceProbe`：恢复所需 UV footprint、法线/切线风险和顶点色等，查询 role 对应的 variation metadata。它不运行完整纹理集合或 lighting。
4. **照明风险。** 当前光源/cluster 的成员和衰减变化、法线与视向范围、roughness/specular lobe、阴影/AO/噪声等风险共同决定 lighting rate。不能用上一帧低 contrast 认证当前帧安全。无法界定的照明项留在 full-rate，并且其成本可观测。
5. **选择率与代表位置。** 优先满足预算的 2×2，其次方向性半率，最后 1×1；方向按不同方向的风险决定，不按随机 lane。每个像素在每个 signal group 中只属于一个样本覆盖集合。

`SurfaceProbe` 是本地新算法的一部分，必须同时给出 CPU reference 和 GPU consumer。能在组内复用的 Product context/primitive setup 只构造一次；分 pass 时只落真正可复用的紧凑数据。对 mixed cell 如果为判定已解码了多个 primitive，应如实计入几何成本：该区域可能只节省纹理/光照，不能再宣称所有几何也少算同等比例。

### 6.2 纹理与属性风险信息如何落地

对实际 resident texture 的采样语义生成粗粒度、多级 variation 信息；可采用局部区间/normal cone 等具名本地结构，不直接将平均颜色 mip 当上界。查询覆盖整个 coarse footprint 和实际过滤支持域；跨 mip blending、UV transform、wrap、色域解码、压缩/resize 和缺页替代都需与真实 consumer 一致。遗漏任一分支时按未知处理。

纹理 metadata 的 GPU 内存、制作与驻留成本纳入 profile 预算：仅已使用 role/必要层级存在；缺失时保持同一采样器语义的 full-rate，不额外保留第二份完整材质纹理。TextureResidency 发布一份一致的纹理+variation revision；Loader 只提供资产数据，不拥有长期 GPU texture 或 metadata pool。

若资产 metadata 判定过于保守，优先改进其 footprint/局部性或有限 probe，而不是无条件放行高频材质。其检索范围、误差定义、shader 数学与简化映射要作为本地算法记录，不能声称来自 CPS 的现成材质前置分类器。

## 7. 逐像素事实：移除 Surface 复制 motion 的耦合

选择重构现有 `TemporalFactsPass` 与 `temporal_facts.ts`，使其不再读取 `surface.motion`，由 visibility/depth/instance/current-previous camera 直接产生 rigid motion、identity、validity 与 change/reactive 基础信息；在 FrameGraph 中解除其对重 Surface 求值的依赖。概念图中的 Pixel Facts 是这条现有 owner 的演进，不再并列创建第二个权威 producer。

- 对 rigid opaque，用 depth 逆投影恢复当前 world position，经 `previous_from_current` 和上一帧 camera 求 previous UV，输出 current UV minus previous UV。已有 `previous_clip_for_surface` 是可复用数学入口。
- 统一当前/上一帧 jitter、内部尺寸、UV 方向、动态分辨率和 FSR3 motion scale；不得在新旧转换处重复去 jitter 或反转符号。深度精度造成的 motion 差异需与原三角形恢复做误差检查。
- 天空保持现有仅相机旋转的 motion；缺失/无效 previous transform 通过 validity/reactive 暴露，不伪造有效零速度。
- 未来 skinned/deformed representation 必须发布 previous mapping 或 motion facts；刚体 depth 方法不适用于所有形变。
- 更新 `FrameProgram` 的 `surface-motion → temporal-motion` 依赖、`FrameProgramLowering`、`TemporalFactsPass` input 与 `SurfaceProducts`，删除 Surface 输出 motion 的无用 storage attachment/binding。可短期使用现有内部命名完成同批切换，但最终只能有一个物理 motion 权威。
- 材质/LOD/纹理发布变化沿用现有 identity/change 信息；新采样率变化是 quality/reactive 提示，不混入几何 winner identity。第一版分类不依赖历史颜色，因此 camera cut 不需要为可用性保留旧采样结果。

## 8. 有界工作组织、样本映射与容量

### 8.1 少量 execution lane 与三类物理工作

lane 由协商后的 texture-binding profile、少量 closure family 和有限 signal/output layout 决定，不按 material 实例、每个纹理组合或每种 rate 增长 PSO/queue。保留 Standard、Unlit、Coated 的语义区别，不沿用旧 set0 热 / 七等分冷池的工作量假设。

| tile 内容 | 默认执行方式 | 必须避免的成本 |
| --- | --- | --- |
| 同 profile/family，全部 full-rate | tile descriptor 或隐式坐标；直接执行新 full-rate worker | 给 64 个像素分别写 record、全员 scatter |
| 同 profile/family，全部同 coarse rate | 紧凑 tile/rate descriptor；通过固定映射生成代表 sample | 对规则 sample 存完整逐像素映射 |
| 混合材质/rate，或昂贵稀疏信号 | tile-local prefix/compact，连续 sample packets，带本 tile 精确 mask | 少量活跃 lane 分散跑大 shader、无限全局 hash/spin |

任务优先在 tile 邻域内打包；材质可跨 tile 压紧 tail，照明按 cluster-local batch 保持灯列表局部性。若跨 cluster 合并，必须显式构造正确灯集合或逐目标读取；不能直接借用代表像素的 light list 漏光。第一版优先禁止该直接光合并或使该信号 full-rate。

workgroup core 路线使用有界 scan/共享内存；可选 subgroup specialization 只改变物理调度，不改变 sample/mask/输出语义，且不假设固定 wave32。不把 GPU work 本帧读回 CPU 决定 dispatch 数。

### 8.2 样本和输出的逻辑合同

内部数据包括 `TileState`、`SurfaceSamplePlan`、`SamplePacket`、`SampleResult` 和 GPU counters/indirect。名称是建议职责，不要求机械各建一个 class 或正式公开 product。

- `TileState`：有效像素域、implicit/mixed 状态、各 signal rate、packet 段和是否回退；每帧初始化，必要的状态按 tile 总数分配，不依赖可能溢出的队列才找得到 tile。
- `SamplePacket`：代表坐标、rate/覆盖 mask、lane、需要的 key/context 引用、结果索引；身份校验使用已发布 generations，不能把一个 primitive 的顶点地址应用于跨 primitive 的其他像素。
- `SampleResult`：该 layout 实际消费的材质/照明信号，不默认存位置、全部纹理或完整 GBuffer。
- 像素到 sample 的映射优先由 tile/rate 推导；mixed cell 用有限 mask/局部索引。没有证据不分配全屏高字节数的反向映射。64-bit mask 可以两个 u32 表示，core 路线不要求 64-bit 原子。
- 对一个 signal，计划阶段即建立覆盖集合的互斥与完整性。无背景有效像素遗漏，无跨域 splat，无“先写粗结果再由异常覆盖”的常态。

### 8.3 全屏 full-rate 与 overflow 都必须正确

容量预算包括 tile 状态、descriptor、sample records、结果、indirect、metadata 与可选 compact fields；创建前检查设备 limits，不能把每 lane 简单固定为 P/7。由输入尺寸推导最坏请求数与 u32 计数溢出界；较大分辨率使用合法二维 indirect 网格/分块寻址，不盲目把 `ceil(count/64)` 塞进单维限制。

推荐采用 **tile 级提交状态 + GPU finalize + full-rate 退路**：

1. Builder 计算 tile 对各队列/结果池的有界需求，尝试预留；只有 record 与 result 的所有所需空间均有效才发布该 tile 为 normal。跨 lane 的部分预约可浪费位置，但不能部分提交像素结果。
2. 任一必要池不足，该 tile 标为 fallback；可能已写出的 records 由消费前的 tile 状态判无效。Builder 不写最终 HDR，也不启动等待其他 workgroup 的自旋。
3. 独立 finalize 在所有 producer 之后建立合法 indirect/计数，失败 tile 通过固定 tile 状态仍可定位；fallback 不能再依赖另一个可能溢出的 repair queue。
4. 正常 workers 跳过 fallback tile。新 full-rate fallback 在同帧按 tile 与 profile/mask 完整求值；必要时固定有限 profile 扫描作为极端退路，不能成为常态的每材质全屏扫描。
5. full-rate 写域与 coarse Resolve 写域互斥。阴影/AO 等同信号也按该 tile 的最终模式决定消费者；不能混合半帧旧结果或把未写空间当黑色。

跨 dispatch 的 producer/consumer 使用 FrameGraph 显式资源边和 pass 顺序。不要把 `storageBarrier()` 当全局 workgroup 间同步。统计 overflow 原因与覆盖：可用但经常回退不代表性能目标完成。资源配置根本不合法应初始化时明确报错或协商到可运行的本架构 profile，不能以 GPU 越界作为运行策略。

## 9. Geometry / Material / Lighting Workers

### 9.1 几何上下文与 setup

保持当前 Product page/asset/group/meshlet/generation 验证；先按 sample 或组内共享实例恢复 context，避免同一 sample 对每个顶点重新走全部元数据。跨样本只共享不变量，例如同 primitive 三顶点/投影数据；透视权重、当前 position、UV 和 footprint 仍按真正 sample 位置求值。

复用 `CalcFullBary` / `Interpolate2DWithDeriv` 所依据的透视数学；不能用仿射 UV 或粗率复制梯度替代。跨 primitive sample 以合法 winner 的代表位置求值，覆盖其他 primitive 的误差由前置连续性与 variation 判定承担，不能从一个 primitive 插值出其他 primitive 的精确属性。

先做组内需求驱动 setup；只有多个重 sample 使用同一 primitive 且节省超过建表/写读成本时，才扩展到 frame-local shared setup pool。miss、近裁剪、退化、容量不足走同一 worker 的正确直接恢复。缓存 key 至少含 instance、primitive、representation 和相关 generation。原 `LargeTriangleSetupCache` 不能仅接线即宣布 VG 支持，也不为所有可能可见 primitive 预生成。

### 9.2 材质求值

从 `surface_material_kernel.ts` 拆出可独立调用的几何/closure 求值与照明函数，保留 canonical material 的 base/normal/ORM/AO/emissive/specular/IOR/coat、顶点色、UV transform、sampler、颜色解码和缺页行为。`surface_hit` 不再拥有最终像素写出与 motion，它的数学部分进入新 worker。

无 normal texture 等静态不可达分支可裁剪；rough nonmetal 仍保留其物理镜面和能量处理。不得把“便宜的另一种 BRDF”混称同算法 specialization；材质模型近似如未来单独采用，需明确质量策略和源依据。

compute 的 UV 导数由代表样本几何解析得到，使用明确的 `textureSampleGrad/Level` 语义；compact 后的邻近 invocation 不等于屏幕相邻像素。区分一像素原始导数与 coarse footprint 的扩大，避免 upscale ratio、rate 和 UV transform 重复缩放。若 coarse filtering 改变细节，应在 metadata/误差预算中一致计算，而不是只改 mip bias 掩盖块状。

### 9.3 照明分频与复合信号

默认同率、同依赖的 material + lighting 融合，以避免不必要的 closure 写读；寄存器压力或不同率带来的节省要求拆分时，使用有限的紧凑 layout，不强制融合成长巨型 shader，也不强制全屏 GBuffer。

| 信号 | 首个完整范围中的选择 | 保持的语义 |
| --- | --- | --- |
| 材质 base/normal/ORM 等 | variation 允许时 coarse，否则所需字段/full closure 全率 | 普通贴图 PBR 必须出现实际 coarse 消费，不仅常量 Unlit |
| emissive/高频属性 | 常量可共享；未知细线等全率 | 不通过反照率或曝光抹掉亮点；需要精确字段时支付其真实成本 |
| sky/环境漫反射 | 允许的低频量 coarse；高频 albedo/occlusion 在目标像素调制 | 保存可分离量，不能从已乘 albedo 的颜色反除得到 irradiance |
| 环境镜面、DFG/energy compensation | 满足 normal/roughness/view/环境变化预算才 coarse；否则 full-rate | 保留 base/coat 能量耦合、specular AO 与 split-sum 语义，不默认删镜面 |
| direct local lights | cluster/member/衰减/方向风险允许才共享相应项 | 不能用代表 light list 漏掉邻像素灯光 |
| directional sun / VSM | 无当前安全证据时相关受阴影信号 full-rate；可分离时单独计算 shadowed contribution | 阴影仅作用于其真实 direct lobe，不能把一个 shadow mask 乘整个最终 radiance |
| XeGTAO 与 material AO | 当前帧逐像素可见性消费或单独有条件共享 | 保持当前 `min(materialAO, Xe)` 与 specular AO 的非线性依赖；不能错误变成整图乘 AO |
| clearcoat、sharp specular、未知随机效果 | 首版保守 full-rate 相应信号/closure | 保留薄高光、coat attenuation 和噪声尺度；不把噪声复制成大块 |

不同率首先选有限可组合的 signal groups，而非每个 BRDF 小项都有独立队列。如果拆解现有非线性公式不能严格保持语义，就让该耦合组全率。第一版不要求所有信号都降频，但完整模块必须在 ordinary PBR 上同时减少确有占比的材质及照明工作。

## 10. Surface Resolve 与唯一写域

代表位置必须记录或可推导。对受 coverage 限制的 cell，选真实有效表面位置作为代表，不能随意移到块中心后借用错误 primitive；sample 的实际位置与过滤 footprint 分开表达，避免半像素偏移。

推荐首版物理输出：full-rate worker 直接写最终 HDR；coarse worker 写不可变 sample signal results；Resolve 仅写计划中 coarse 的目标像素，并且只读取 sample results/已发布事实，**不读取正在写入的最终 HDR**。既免全率结果全部落另一张大图，也避免原地邻域去块的数据竞争。

Resolve 的基础是本像素 owner sample，必要时有限邻域重建只访问同 sharing domain、同信号 layout、深度/法线风险兼容且状态正常的 samples；邻居不可用时回到 owner sample，不跨轮廓取色。重建核、归一化、代表位置和拒绝条件建立 CPU oracle；首版可用受限双线性/双边形式，但这属于本地算法，不能称已移植 DOOM 去块。禁止使用源演讲承认存在 race 的同 UAV 原地滤波。

全率像素不被再次滤波；背景/无效身份保持既有明确处理。每个目标信号在计划中已有唯一 producer，最终 composition 按依赖组合，不通过粗写后覆盖补救完整性。若 material 可 coarse 而 lighting full-rate，Resolve/lighting consumer 需获取必要的 closure 字段，不能隐式重新执行完整材质。

继续在明确的最终 radiance 边界做 working-color 转换与本帧 pre-exposure：同率 full worker 与 coarse Resolve 使用同一辅助函数，恰好转换/乘曝光一次；中间信号标注是否为颜色、能量、无量纲或 pre-exposed，不能混用后再插值。HDR/FSR3 全分辨率输入不等于 FSR3 会自动修复粗着色遗漏。

未来 SSSR/GI 对 shading normal、roughness 等的真实需求由 `SurfaceProducts` 与 Frame Program 声明；若某消费者要求全率字段，必须真实生产并计成本。内部 samples/队列仍属 shading 私有，不全部升级成跨 owner product。

## 11. Owner、切换与生命周期

| Owner / 当前入口 | 重构职责与边界 |
| --- | --- |
| shading：`render/surface/SurfaceMaterialPass.ts`、`SurfaceProducts.ts`、`SurfaceKernelBindingPlan.ts` | 以 Surface coordinator 重写/替换原 pass；拥有 work builder、有限 worker families、样本/容量、Resolve 与诊断；名称可保留但算法责任必须下沉 |
| shader：`surface_probe.ts`、`surface_sample_work.ts`、`surface_sample_worker.ts`、`surface_geometry.ts`、`surface_material_evaluation.ts`、`surface_lighting.ts` | 维护 Probe/Builder/worker/Resolve 的单一生产主链；旧窄 planner、Dense/七 lane producer 和旧 ABI 已从生产源码切断 |
| geometry/assets：`assets/geometry-product/*`、`gpu/GeometryProductGpuAbiV1.ts`、Cooker | 发布连续性与风险，版本/recipe/Native-WASM 统一；shading 不自建第二套几何权威 |
| materials-textures：`GpuMaterialStore.ts`、`GpuShadingMaterialAbi.ts`、`TextureResidency.ts` | 一致发布 role 风险/variation/residency 代际；保持有限物理纹理 profile |
| temporal：`TemporalFactsPass.ts`、`temporal_facts.ts` | 逐像素 motion/identity/validity，解除 surface-motion 依赖；未来缓存另有明确所有者 |
| frame-runtime：`FrameProgram.ts`、`FrameProgramBindings.ts`、`FrameProgramLowering.ts`、`RendererCore.ts` | 显式 producer/consumer、有限 topology/capability key；Renderer 只创建与组合 owner |
| lighting/environment/AO/VSM providers | 保留原 radiometry/阴影/可见性合同，按实际 signal demand 暴露依赖，不因 Surface 重构重建整套效果 |

资源按尺寸、协商 profile、device epoch 管理：frame-local 队列/结果不留作隐式 history；稳定帧重用可重用 pipeline/layout 与尺寸资源。resize 重新计算容量和映射；scene/Product/texture 换代用一致发布快照；device loss 重建设备资源；camera cut 清除现有 history 和采样相关提示。旧 GPU 资源按完成 fence 延后销毁，不依赖当前帧同步等待。

从 production 依赖中移除：独立的旧 `Surface/conservative spatial frequency`、dense 内后置七 lane 分配、旧 P/7 容量规则、HDR+motion block copy、Surface 强制生产 motion 的依赖，以及不再使用的 ABI/测试/源文件。`LargeTriangleSetupCache` 是否删除以真实全部消费者为准，不能误删仍服务其他功能的代码，也不能为“将来可能用”继续挂在新主链。

CPU oracle/独立诊断 harness 和 Git 历史可用于对照；新架构的全率模式是正常消费者，不允许新增 `oldRenderer/newRenderer` 或永久双生产 A/B 路由。

## 12. WebGPU 能力与资源约束

按 2026-09-30 核对的 WebGPU/WGSL 文档制定 core 方案；规范有某能力不代表所有目标浏览器已支持。实现前协商实际 adapter/device limits 与功能，不把 source HLSL/Slang 的 bindless、BDA、固定 wave 或 64-bit atomics 搬入 WebGPU 假设。

- 基础：现有 storage buffers/textures、workgroup memory、u32 atomics、显式 compute dispatch/indirect 与 pass 间依赖；`subgroups`/`shader-f16` 仅协商后特化，不是主线必需能力。
- 所有 workgroup 成员需要执行的 barrier 之前不能有非 uniform 的 return；跨组完成由后继 dispatch 建立，不用设备级自旋 barrier。
- 分类/probe 与重 worker 使用各自的需求闭包，不能在现有接近 sampled/storage binding 上限的巨型 Surface layout 上不断追加 metadata。可拆小布局、打包记录或缩减同时活跃字段，创建前验证。
- 协商 `maxStorageBufferBindingSize/maxBufferSize`、storage/sampled slots、workgroup memory/invocations、dispatch dimensions 等总闭包；实际每个 shader 的占用单独检查。
- 没有当前帧 GPU→CPU→GPU visible/work 控制；观测计数延后异步读回，不改变本帧调度。不引入独立 submit。
- 预算按 symbolic `tileCount×stateStride + descriptorCapacity×stride + sampleCapacity×(record+result) + demanded fields + metadata` 计算；字节布局在实现收敛时确定，不用一个理想平均 coarse 比例预分配到最坏情况下丢像素。

## 13. 后续方向与明确不做

主线完成后依据剩余耗时选择：局部 setup 更深复用、IBL 过滤、采样等价、绑定缓存等；有明显跨帧重复且稳定映射时，再实施选定材质/irradiance cache。缓存的 signal、身份、坐标、footprint、version、invalidation、eviction 和 miss 处理必须单独闭环。

不把 VisibilityKey 直接当历史地址，不以灯版本未变推导最终 radiance 未变；view-dependent specular、动态 shadow/AO/GI、曝光、LOD、驻留和遮挡揭露都能破坏重用。对象/纹理空间 cache 与屏幕重投影 cache 是不同物理方案，不混成一个已完成的“temporal cache”。

本次不全面重写 HZB/recovery、不创建大 GBuffer、不建设多轮 DACS 生产路径、不引入全员 material sort、不把降低内部尺寸当作默认收益来源、不自动简化 PBR 模型。透明/体积/形变全套支持和所有未来 provider 不捆绑到首个 Surface 重构模块。

## 14. 来源、移植边界与未决参数

来源是算法/阶段证据，不是性能担保。主线为本地设计，尚未找到一个完整开源实现同时满足本工程 VG Product、有限纹理 profile、PBR/Coated、跨 primitive 判据、motion、GPU overflow 与 WebGPU 生命周期。现有合法数学移植继续沿用原 ledger；下面的参考不能整体打包宣称“完成移植”。详细固定文件与映射见来源账本本日最终设计条目。

| 来源 | 固定版本 / 许可 | 选取内容与本地对应 | 不包含的承诺 |
| --- | --- | --- | --- |
| The Forge | `cd5046893faba2dc7869243873bf01f02a6f0df9`，Apache-2.0 | `VisibilityBufferShadingUtilities.h.fsl::CalcFullBary/Interpolate2DWithDeriv` → sample 位置/梯度数学与 oracle | 不提供本地 sparse scheduler |
| Wicked Engine | `df44c3db4c4927492bc9c791eac715d98d7ed091`，MIT | `visibility_resolveCS.hlsl/visibility_shadeCS.hlsl` → tile mask、profile 分流与消费边界参考 | 源仍逐像素求 Surface；不等于多像素共享样本，native binding 不直接移植 |
| Intel DeferredCoarsePixelShading | `63ad5c1adafbfcc2869a200f50a5ea11f28b4887`，源文件 Apache-2.0 | `ComputeShaderTile.hlsl::RequiresPerPixelShading` 与 coarse/full/light 消费 → 分信号照明参考 | 已有 GBuffer 后的判据不能冒称节省前置材质 |
| DOOM: The Dark Ages VRCS | GPC 2025 原始 71 页幻灯片；PDF SHA256 见 ledger | 14、23–25 页调度；27–38 页代表位置/去块/噪声；42、51–58 页细三角形与 surfaceID；62 页消费者精度 → 主线设计参考 | 未取得完整许可源码；surfaceID 属未来提议；不复制原地 UAV race 或承诺原平台收益 |
| Decoupled Sampling | Ragan-Kelley 等，2011，NVIDIA/作者论文页 | visibility-to-shading many-to-one 思想 → 采样与覆盖解耦 | 非当前 WebGPU 可直接部署的完整 donor |
| Visibility Buffer | Burns/Hunt，JCGT 2013 | 紧凑 identity + 延后属性求值 → 保留当前 Visibility 底座 | 不直接提供自适应样本压缩 |
| WeakKnight OSS | `473a59bbcdd30e3366cc567d66a5a97353620d48`，Apache-2.0 | `ObjectSpaceShadingPipeline.cs`、`RenderTaskProcessing.compute` 等候选 → 后续对象空间 cache 研究入口 | 仅部分主链已核读，Unity/RT 依赖、LOD/完整生命周期尚未审计；不纳入首版 port |
| DACS 与独立实现 | 作者 2018/2020；独立实现 `da514fe9f6b1a2c5a732b0b9f2e20c25227960e3` 未见明确许可 | 对照采样数与调度成本，保留研究记录 | 不复制未知授权代码，不实施第二套多轮主链 |

实施中需收敛的参数限于：各 signal 的误差预算、variation metadata 的层级/精度与内存、候选 probe 上限、sample packet/tile tail 打包方式、有限 intermediate layouts、容量 profile 和 subgroup 特化。**不再重新讨论是否先做小优化、是否保留旧生产 path、是否先上全帧颜色缓存。** 参数收敛与真实 GPU consumer 编码同步推进，不新设逐批批准门槛。

## 15. 验证、可观测性与完成标准

开发中加入 GPU-resident counters/debug views：有效 PBR 像素、实际 material/lighting samples、rate 分布、full-rate 原因、same-primitive 与 cross-primitive 的命中/拒绝、probe/setup 开销、队列 attempted/written/overflow、fallback tile 数。不同 signal 的样本量分开统计，不能拿低成本 Unlit 的合并率替代普通 PBR。

按调试需要运行 targeted checks；在完整模块贯通后集中 typecheck/build/必要测试并修复真实编译失败。重点检查：

- CPU/WGSL：plan 的完整/互斥覆盖、方向性 rates/奇数尺寸、perspective gradients、continuity/UV seams、footprint/variation、motion/jitter/previous mapping、exposure/色域一次转换。
- 有界工作：零工作、全率满屏、单 profile 满屏、最坏混合、恰好容量/多池 overflow、tile 部分预约但不部分提交、合法二维 indirect 和 background/error 行为。
- 信号组合：高频 base/normal/emissive、金属/coat、高光移动、cluster 边界、VSM/AO、随机噪声与 consumer-demand 字段。避免只测静态粗糙平面。
- Product 与生命周期：Native/WASM 一致、LOD 切换/缺页、resize/cut/scene replace/device epoch，以及旧依赖确实删除。

优先改有意义的现有 `surface-product-closure`、`surface-reconstruction-projected`、`temporal-fabric` 与材质/Product 测试；删除/重写只验证被删除 planner/ABI 的测试，不建立断言类名存在的伪检查。

主链贯通的开发完成标准：新生产消费者实际少算 ordinary PBR，有限 workers/Resolve 同帧输出完整，moving camera 的 motion 正确，跨 primitive 连续性有真正消费，未知/高频/Coated 能在同架构全率运行，overflow 可恢复，旧生产耦合已删除且构建/必要测试通过。

性能与正式采用是另一级结论：在整体 Next 适当验收阶段，用固定 revision/场景/尺寸/相机/驱动/温度条件测量分析+probe+工作生成+重 shader+重建及整帧 P50/P95，并覆盖代表材质/画质/lifecycle 矩阵。旧基线用 Git revision/独立 harness 对照，不留双生产桥梁。只有源码映射、CPU/WGSL oracle 与真实生产 GPU 消费等证据齐备才提升对应采用状态；样本少但总时间不降不能叫性能改善。

当前生产事实与实际验证见执行文档的各阶段及 2026-10-01 补齐记录。已有有限 material-coarse/lighting-full closure layout、目标法线恢复、受限 GPU 重建、需求驱动 TriangleSetup 和真实异步 counters；normal-map/ORM/Coated 等未证明信号保守全率。本文仍为目标约束；本地 Chrome 开发验证不等于正式 browser matrix、完整画质或性能采用。跨帧 cache 仍按 §13 的重复成本与稳定映射门槛后续选择。
