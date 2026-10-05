---
id: next-execution/surface-work-v3-optimization-v1-phase0-inventory-2026-10
state: history
verifies:
  - OEngine/src
---
# Surface V3 优化 Phase 0：生产依赖、容量与删除清单

日期：2026-10-03。核对源码：`0676cf28478bc2f4b96af7138f45ef33f1216a3f`。此文固定实施输入，不声称优化已在 renderer 生效。

配置：[冻结 profile](../../validation/profiles/surface-work-v3-optimization-v1-baseline.json)。容量政策：[源码](../../OEngine/src/gpu/SurfaceOptimizationCapacity.ts)。目标：[设计](../next-design/surface-work-v3-optimization-v1-design-2026-10.md)、[执行顺序](surface-work-v3-optimization-v1-execution-2026-10.md)。

## 1. 已固定与核查的身份

- 当前基线完整 SHA、三个历史对比 SHA 均已由 Git 解析。阶段提交不会覆盖历史身份。
- Dungeon SHA256 已重新读取文件核对，为 `cac0fc8c16d107e7ac4e69efde89c2cb6ef4bc66c34456a4dd0923218e5aafb1`。
- GTX 1650 Ti、Chrome 154、1080p、曝光4、低/高距离scale及40/40/40成功提交帧轨迹来自已有测量报告；本阶段没有重新浏览器采样。
- timing/detailed 分开，逻辑MB与容量MiB分开。VSM-on初始化失败仍是待修事实，完整功能组独立记录，不拿VSM-off报告代替。

## 2. 旧产品分配 → producer → consumer → 销毁

表中 P=width×height，S=旧sampleCapacity。`scratch` 指唯一 `SurfaceFrameResources`：extent变化时retire，完成promise之后destroy，`SurfaceWorkRuntime.destroy()`最终释放。计数/indirect/transient纹理由FrameGraph生命周期处理。此表列出未来删除对象，不提前删除当前消费者仍使用的资源。

| 产品 / 容量 | 分配与producer | 生产consumer与诊断consumer | 替换阶段 / 销毁入口 |
|---|---|---|---|
| `SurfaceWork frame partitions`；tile48 B、sample32 B、exception16 B等 | `SurfaceWorkRuntime.addToGraph`，classify/finalize | witness、material lookup、Geometry、resident kernel、Lighting；Diagnostics读header/counters | Phase2新模板/局部map；scratch retire/destroy |
| `SurfaceWork sample map`；4P | classify的r32uint transient | Reconstruct；diagnostics通过reconstruct计数观察 | Phase2模板/Phase5map；FrameGraph回收 |
| `Surface/exact input witness`；52P | `SurfaceCacheIdentityPass.addToGraph` | Material lookup、resident kernel binding29、Lighting classifier | Phase3地址/依赖引用；scratch。删除pass后删其constructor/settings |
| `Surface/exact view epoch`；camera block+4 | witness view compare | witness shader；不直接诊断读 | Phase3 view-independent字段去camera blanket；scratch |
| `Surface/residency epoch`；(65536+2)×4 | `SurfaceDependencyEpochPass`全表比较 | Material lookup、resident kernel的residency binding | Phase3逐资源版本；scratch；pass无独立长期buffer |
| `Surface/GeometryRecord buffer`；192P | `SurfaceGeometryPass`cache classify/miss resolve | `appearance_resident_kernel.ts`与`surface_geometry_reader.ts`，Lighting；Diagnostics读count非record | Phase3 demand hot/cold；scratch；settings由Geometry.destroy |
| `Surface/GeometryRecord miss queue`；4S | Geometry classify | Geometry finalize/resolve | Phase3有界batch需求并集；scratch |
| `Surface/exact field versions`；76P | Material lookup + publication evaluate | lookup读取完整field版本；resident kernel写回 | Phase3 FieldStore keys；scratch |
| `Surface/field values`；48P | publication evaluate | lookup读取复用；resident kernel读写 | Phase3单份FieldStore values；scratch |
| `Surface/material fields`；六层rgba16float=48P | `SurfaceFrameResources.importFields`，lookup/重worker | Lighting与resident kernel；没有独立debug texture消费者 | Phase3 transient refs/fields；scratch texture retire |
| `Surface/material bounded miss queue`、`ordered miss queue`；各8S | Material lookup与compact | compact、per-program publication indirect worker | Phase3 masked有界队列；scratch |
| `Surface/material hit mask`；4S | Material lookup | Geometry与resident kernel | Phase3字段需求mask；scratch |
| `Surface/dirty lighting queue`；8S | Lighting classify | Lighting dirty-worker indirect | Phase4按新signal需求重建；scratch |
| `Surface/signal witnesses`；32P | Lighting classifier | Lighting reuse判定；没有独立diagnostic读 | Phase4 SignalStore依赖；scratch |
| diffuse/specular/coat/IBL packets；各16P | Lighting main与clear分支 | Reconstruct；Diagnostics仅读lighting计数 | Phase4紧凑packet/ZeroRef；scratch |
| 四signal history pairs；64P | Reconstruct.prepareFrame创建，reconstruct写 | 下一帧reconstruct；Diagnostics读history计数 | Phase5删，SignalStore替代；Reconstruct.retireCompleted/destroy |
| identity history pair；32P | 同上rgba32uint | Reconstruct history匹配 | Phase5删；同上 |
| age history pair；8P | 同上r32uint | Reconstruct history年龄 | Phase5删；同上 |
| material/geometry/lighting/reconstruct counts与indirect、audit、snapshot | 各pass的graph.create；Diagnostics生成snapshot | Diagnostics与`SurfaceDiagnosticsCapture`异步copy/readback；runtime仅GPU indirect | Phase2–6迁移schema/actual count；FrameGraph管理，诊断不能控制本帧work |
| HDR/reactive output | Reconstruct graph.create/写 | Sky/Aerial/FSR3/显示 | 保留必要全率输出；FrameGraph管理 |

`FrameProgramLowering.lowerSurfaceWork`是真实接线入口；当前仍一次把全extent交给SurfaceWork。Phase5改成batch的明确producer/consumer顺序，不通过新旧wrapper兼容。

绑定撤销也属于删除：publication worker的dense cache/cacheValues/fields/geometryKeys bindings，Lighting的pixel witness bindings，Reconstruct的12个history读写bindings，debug snapshot旧字节公式，resource import晚绑定闭包全部需同步。删除allocator调用而保留bindgroup/graph resource引用不算完成。

## 3. 保留系统与新增职责

GPU Scene、Visibility/Depth、FrameGeometryVertices/Arena、资源publication、LightCluster、VSM、XeGTAO、Environment、Atmosphere、TemporalFacts与FSR3继续各自拥有资源。新增Surface setup/summary/cache不能藏到共享账目中。唯一GeometryRecord producer仍为SurfaceGeometryPass；Appearance/Lighting仅消费；Reconstruct不能增加材质纹理采样。

WinnerIdentity用于精确获胜几何；SharingDomain只产生可共享候选；PixelAddress/FrameSampleAddress/PersistentSurfaceAddress不混用。FieldRef/SignalRef区分Constant、Persistent、Transient、Zero并带generation；hash定位而完整key确认。缓存可近似的部分是footprint有效域，不是省略资源版本或物体身份。

## 4. 字段与信号依赖表

表是编译器/worker必须产出的依赖语义，不宣称当前已经逐字段拆分完毕。`AppearanceGraphCompiler.ts`的依赖bit为Surface1、Texture2、Geometry4、Dynamic8、View16、Nonlocal32、Material64（当前shader用21/2/40 masks），Geometry/Surface/View仍共享pixel witness；Phase3必须拆掉该耦合。

| 输出 | 稳定key/输入依赖 | 只收紧本字段/信号的条件 |
|---|---|---|
| base color / diffuse reflectance | program/参数、相关UV chart/texture/sampler/filter、vertex color、实例依赖 | UV/color seam、局部颜色variation；不因coat/view变化失效 |
| ORM与closure标量 | 对应UV/纹理通道、program、材质参数 | roughness/metallic/AO分别bounds；可常量输出ConstantRef |
| normal/tangent | normal texture与UV、tangent frame/handedness、normal/filter参数、必要形变 | normal cone、frame seam；不能连带base/常量全率 |
| coat字段 | coat feature、coat normal/roughness/weight闭包 | feature缺席ZeroRef；存在时按自身依赖 |
| emissive | authored场、纹理/HDR值、UV及动态参数 | 高频/HDR单独精度与率；E直接字段引用 |
| view/dynamic/nonlocal字段 | 实际GPU语义和provider版本 | 不能藏在stable key中省略；同材质稳定字段仍命中 |
| Ddirect | position/normal、必要BRDF参数、light-set、shadow有效域 | cluster/shadow边界与非可分BRDF残差 |
| Denv | normal、environment、明确AO/coat能量合同 | 高频normal/AO依赖；不包含Senv或E |
| Sdirect / Senv | view/reflection cone、normal、roughness/F0与light/shadow或environment | 低roughness、高反射变化与细亮点 |
| Cdirect / Cenv | coat存在/参数/frame、view及相应provider | 独立细率/历史；缺席零work、零写、零history |

Texture局部bounds需要沿表达式传播到最终字段；nonlinear/branch/normalize奇点unknown只拒绝有关输出。普通资产和Product使用同一发布合同，LOD lineage或metadata缺失的局部必须显式计数。

## 5. 最坏容量推导与实现约束

`SurfaceOptimizationCapacity.ts`固定初始池和严格的创建前推导，不创建GPU资源，也未接旧renderer。

- tile=64个**padded目标槽位**，NPOT不按实际可见像素减少容量。
- 默认每批4096tile=262144槽位。1080p=32400tile，7批×4096+最后3728，共8批；没有CPU本帧visible/readback控制。
- per-target容量ceilings：address128 B、hot64 B、cold128 B、fields96 B、queues64 B、signals128 B、maps32 B。它们约束所有成员和管理字节总量，不是多个独立同尺寸数组的预算。
- queues必须用地址+字段/信号mask聚合，或证明其多队列总量仍≤64 B/target。6字段+7信号每项独立复制宽task会超预算，不允许以“每队列count≤R”误判总量。
- 七个可能活跃lighting分量每项16 B最坏=112 B/target，128 B envelope余16 B；metadata/ref若放入同池必须仍满足上限。E通常字段引用、absent coat为ZeroRef，但容量不能依赖场景恰好没有coat。
- fields96 B是六vec4f宽payload上界；FieldStore key/metadata算在128 MiB持久pool中，transient索引/管理算queue/address/map，不能再复制一份完整fields。
- plans含64 KiB controls/indirect及≤1008 B/tile；default正好4 MiB。program数超过control预算时需预发布分段/固定program range，不能现场越界。
- `R = 64 × min(4096, floor((planLimit-64KiB)/1008), floor(poolLimit/(64×stride))...)`，poolLimit同时受显存池、maxBufferSize、maxStorageBufferBindingSize约束；align256。连一个tile都放不下则发布失败。
- cold512 B/target时R降65536，1080p32批；字段/信号更宽同理。工作区生命周期复用，不扩大显存、不漏像素。
- persistent pools按合法binding大小分段；不依赖未协商binding array。Phase3/4实际consumer必须实现选段/profile，planner分段不代表它已完成。
- outputs按HDR8 B+reactive4 B/目标预留24 MiB，1080p实际12P约23.73 MiB。更大extent超预算明确拒绝；以后支持更高分辨率需显式修改预算，不静默使用1080p容量。

default scratch164 MiB、FieldStore128、SignalStore64、variation32、outputs24，合计412 MiB；envelope余100 MiB供对齐/退休重叠/扩展。decoder、identity/layout及冷页管理都要进入对应池，不能另分隐形数组。

## 6. Phase 0 完成核查

已运行：Git revision解析、资产SHA256核对、源码allocation→consumer→release阅读、capacity模块独立strict TypeScript检查、5项capacity定向tests、diff whitespace检查。tests涵盖default预算/完整batch覆盖、cold增宽、低binding limit、NPOT edge slots和非法配置拒绝。TypeScript从`OEngine/node_modules`调用；仓库根没有对应工具安装，首次根路径调用失败后已修正并通过。

未运行：renderer typecheck/build、Native/WASM cooker、WGSL/GPU oracle、browser/截图与新performance capture。原因：Phase0只固定身份和capacity policy；未替换生产算法，不用历史测试支撑新算法完成。正式整链检查在后续真实完成后执行。

本阶段可提交；Phase1的连续域、LOD与局部摘要尚未实现。来源沿用账本固定pins和具名本地方案，不提升上游采用状态。
