# Surface V3 Phase 0：冻结身份、消费矩阵与物理容量清单

日期：2026-10-04（Asia/Hong_Kong）。范围：Phase 0 静态核对，不修改渲染生产代码，不运行新 GPU/benchmark。

对应[最终设计](../next-design/surface-work-v3-cost-bounded-final-refactor-design-2026-10.md)与[执行计划](surface-work-v3-cost-bounded-final-refactor-execution-2026-10.md)§3。本文是面向重构的日期化源码清单，不是稳定 ABI，也不把预算示例写成已分配产品。

## 1. 身份冻结与证据口径

| 项目 | 固定事实 |
|---|---|
| Phase 0 开始 HEAD | bc2747084f04f758ede7f3240ffff70e52ae21ae |
| 生产代码基线 | 14c170785505b316c273a8aed0257fe22056b0d3 |
| 开始工作树 | clean |
| 本次生产代码范围 | 不改 OEngine/src、Showcase 和现有 GPU runners |
| 历史 run06 | daaed9c7303a90e1658265e77e5cda02d63921b4 + 当时 dirty；保留原记录 |
| run06 613 份源码指纹 | 本次重新逐文件 SHA256 核对，全部一致 |
| Phase 0 扩展指纹 | OEngine/src、Showcase、相关 validation lab 共 640 个 tracked 文件 |
| 归档生成WGSL | 31份文件SHA256与run06 shaders记录一致，逐文件冻结 |
| 本次新增资料 | 本清单、执行状态/来源记录及本机静态 JSON |

本机冻结文件：../../.local/surface-phase0/baseline-identity.json、static-capacity.json；计算入口 audit-capacity.cjs。没有提交资产或临时报告，不将本机 JSON 当稳定协议或 formal evidence。

run06 文件字节 SHA256：

| 文件 | SHA256 |
|---|---|
| report.json | e1637c6e0afe84604305b611ff36073360268f354c07bb0990cdd03095580471 |
| capture.json | 525f759219c248f5747e557a0b5b06c37e14f5a9327aecb1dcac6127b845e65a |
| performance-summary.json | 37587528fb3ca5917c174bcffeb10f23d6ed949f0bf6a69888e51ac1fd22de4f |
| detailed-counters.json | 16c8f2b20a9312ad5da0379684bb49f04919d9954479ef32ed5fe0490413d5d0 |
| source-fingerprints.json | 7d0b0ae30cfef4581d28f5a0c68eec1841cff103ee469789d3ce15fb9db5286d |
| source-diff.patch | 7b90840806da4f16c075a7572791df01fdac7a435ba67316834f82daa3458fa8 |

source-fingerprints.json 格式化文件字节 hash 与报告的 manifest 序列化 hash f37322cf…不是同一口径。二者保留，不用一个替换另一个。

资产 examples/assets/three/rendering-lab/dungeon_warkarma.glb：cac0fc8c16d107e7ac4e69efde89c2cb6ef4bc66c34456a4dd0923218e5aafb1。

历史配置固定在 capture/report：Chrome154.0.8037.93、nvidia/turing；GTX1650Ti 型号依据当时 telemetry，adapter.info 未提供 device/driver 文本。1920×1080、internalScale=1、overview、8帧预热/30帧静态timing、独立detailed/运动、AO/FSR3/Bloom/HZB/cone开、VSM/jitter关、sse=4、exposure=4、textureMaxResolution=1024；相机完整矩阵、near/far/FOV和太阳参数取原conditions，不凭“overview”重新生成。

report.complete=true、errors=[]、sourceDrift=false、accepted=false。历史 timing、detailed、movement 和20张截图已完成；这不是本次重跑，也不是严格四版本性能通过。CPU/GPU span/pass sum、阶段P50不可混加，具体时间见设计§2。

## 2. 当前数据流与资源边

权威 composition：[SurfaceWorkRuntime.ts](../../OEngine/src/render/surface/SurfaceWorkRuntime.ts)；前端：[SurfaceCellClassifierPass.ts](../../OEngine/src/render/surface/SurfaceCellClassifierPass.ts)。

~~~
publication dependency epoch：lookup→reserve→commit→resolve
  → material constants palette
  → 每 batch setup reset/request/finalize/build
  → facts → address → Field value/certificate lookup
  → geometry + 3 screen/3 canonical field certificate families
  → Field classify → Signal lookup → Signal classify
  → requests/finalize/nominate/resolve/compact/order
  → 唯一 GeometryRecord → missing Appearance
  → Field Store admit/commit/ref
  → dirty Lighting → Signal Store admit/commit/ref
  → reconstruct planner/reconstruct → 可选详细快照
~~~

batch scratch 由 SurfaceFrameResources 的 named imported buffers 复用，执行队列有序；setup/settings等由 FrameGraph transient 分配。下一batch读取上一batch最终输出/Store资源构成序列依赖。不能把“帧图创建了90个descriptor”当90份resident，也不能假设所有物理buffer只有一份，须按allocator alias/提交退休计算。

### 2.1 GPU 产品清单

记 R=batch targets、K=batch tiles=R/64、P=实际compiler programs、N=material directory rows、S=setup slots、D=dictionary slots。usage缩写：S=STORAGE，U=UNIFORM，I=INDIRECT，CS/CD=COPY_SRC/DST；texture TS=TEXTURE_BINDING，ST=STORAGE_BINDING，RA=RENDER_ATTACHMENT。大小为源码descriptor/ABI，allocator兼容复用可返回较大物理buffer。

| 产品 / producer → consumer | stride、capacity / alignment | 初始化与usage | overflow / lifetime |
|---|---|---|---|
| Workspace counters：各producer→diagnostics | 128u32=512B，4B | atomic，当前整arena clear；S/CS/CD | 必要counter reset；named scratch到gpuDone安全退休 |
| tile plans：facts/classify→request/refs/reconstruct | 64B header+21×24B=568B/tile | header/planes写，其他依赖clear；S/CS/CD | 固定每tile最坏容量；与Workspace同寿命 |
| maps：classify→source/group reader | 21×2×48B=2016B/tile；每64项6bit | 原packed OR写需要zero；S/CS/CD | 每plane固定source/group双map；同Workspace |
| geometry cert：producer→fixed candidate validator | 32u32=128B×R，4B | actual leaf/quad代表写；known gate；同Workspace | unknown拒绝共享，无slot compaction |
| field cert：lookup/family→classify | 52u32=208B×R | payload+known；部分写；同Workspace | 独立unresolved；当前无总proof受理预算 |
| persistent cert：canonical family→Store publish | 52u32=208B×R | mask50/51读旧值后OR，必须reset | 声明参数域，不是旧Geometry cache |
| primitive map：facts→cert/classify | u32×R | actual lane写；同Workspace | 当前前序搜索；不证明值相等 |
| Address：geometry address→lookup/proof/record | 144u32=576B×R，4B | valid leaf按input mask写；同Workspace | 缺input不能读未初始化payload |
| FieldRef / SignalRef | 3u32=12B；15R /6R | constant/default/invalid/zero/store/transient分别发布 | generation验证，batch消费后复用 |
| demands / facts | 各16B×R，facts vec4u需16B | lookup dirty/unresolved，facts每lane写 | last batch extent检查，valid facts gate |
| setup dictionary→setup consumers | 8B×D，payload起点16B aligned | key/slot=0xffffffff，S/CS | 8probe、4weak-CAS retry；失败direct decode；FG transient |
| setup payload：request/build→facts/address/cert/classify | 512B×S，16B | source key后下一dispatch完整struct写 | S满回direct，counter2/3计拒绝；FG transient |
| setup counts / settings / indirect | 32B /80B /16B | shader reset；encoder upload U/CD；indirect S/I/CS | indirect x=0明确写；FG命令局部alias，提交后退休 |
| Demand arena：emit/nominate/resolve/compact/order→workers/publish | 见§3.2；末尾256B对齐 | 整块clear；S/I/CS/CD | field≤15R、signal≤6R；hash满全流exact fallback |
| Demand indirect | 512+32P B，copy offset4B | 从arena两次copy；S/I/CD | 和writable arena分buffer；named scratch |
| Demand settings | 96B，16B struct | 每batch encoder staging U/CD | FG transient，不用queue覆盖同uniform |
| GeometryRecord：produce_geometry→Appearance/Lighting | 720B×R，16B | local record零初始化，mask填入，完整struct store；S/CS | queue≤R，物理slot仍leaf索引；named scratch |
| Field values：Appearance→publish/Lighting/reconstruct | vec4f16B×15R | 只actual destination写；S/CS | f32；读取由FieldRef/mask保证，不整pool清零 |
| Signal values：Lighting→publish/reconstruct | vec4f16B×6R | 只dirty kind destination写；S/CS | 当前f32，未单独分配巨大spill池 |
| FieldStore：admit→commit→refs/lookup | 120u32=480B/entry，4ways | state empty/reserved/published，S/CS/CD | 4ways满则transient；epoch pin/generation；long-lived owner |
| dependency snapshots：lookup/reserve/commit/resolve | 8u32 header+264u32 entries，4ways；8MiB | 单一writer、完整纹理版本；S/CS/CD | >256texture deps拒绝publication；满/epoch耗尽unknown |
| dependency owners | 15N×4B，最小4B | lookup完整写实际fields；S | FG transient；**N不等于P** |
| SignalStore：admit→commit→refs/lookup | 88u32=352B/entry，4ways | state/generation/touched/age；S/CS/CD | slot满transient；真实f32payload；long-lived |
| Store settings | Field和Signal各64B/batch | encoder upload U/CD | FG transient；admit/commit/ref三dispatch |
| Appearance program settings | 32B×P逻辑descriptor/batch | encoder upload U/CD | FG transient；P≤256 production hard limit |
| Lighting settings / view | 64B /16B | encoder upload U/CD | FG transient；dispatch actual lighting count |
| reconstruct args / counters | 16B×B /32B | shader写全部args；diagnostic首batchreset；S/I/CD、S/CS/CD | 当前每batch重算全部B份args；FG transient |
| HDR / reactive | 8Ppixel /4Ppixel B | 每输出像素背景/Surface写；ST/TS，HDR另RA/CS | 实际rgba16float/rgba8unorm；FG输出pool |
| detailed snapshot / settings | SurfaceDiagnosticsAbi总字节 /48B | 第一batch clear，末batch读回；S/CS/CD、U/CD | detailed专用；timing无此graph |
| owner uniforms / disabled资源 | classifier32+96B；lookup32/64B；其他§2.2 | 创建时zero，运行时encoder写settings | explicit destroy，不能隐藏在“每target stride”里 |

### 2.2 辅助/共享产品与退休

当前disabled资源：Field lookup Store16B、Signal lookup Store16B/sun48B/shadow16B、Demand sun48B/shadow16B、Store publish sun48B/shadow16B、dependency disabled32B/settings32B、Lighting参数256B/pages32B/depth1×1/transmittance1×1、reconstruct settings48B/batch16B。单独资源虽小，绑定与创建次数必须计入。

publication常量、routes、runtime inputs、directory、bound descriptors、texture deps、version buffers归GpuAppearancePublication/registry/residency，实际大小按N、DAG、textures计算，不能用256PSO代替N份材质。Surface新增副本仍计本owner。

TextureVariationResidency归纹理owner；设计预留32MiB不证明目前实际resident正好32MiB。GPU Scene、MeshletWork、source/vertex heaps、FrameInstances/camera、Product heap+4banks、cluster/light/active list、VSM atlas/table/content、environment/DFG、sun LUT、AO、TemporalFacts/preExposure均为外部输入，其边声明和generation不能省；新增复制计引擎总账。

SurfaceFrameResources.prepare尺寸变化即清空map，旧buffers等this.done后销毁，新buffers可立即创建。旧、新实际重叠未被当前reservedBytes限制。Store trackSubmission维护inFlight epoch，不意味着host所有资源销毁都自动等GPU；destroy/reset须由外部lifecycle保证。

FrameGraph.ts::get/release在command-local availableBuffers中按compatible usage/size复用，finish后交GPUBufferAllocator并等reuseAfter。allocator按4B规范size，可能借较大兼容buffer；pending/cached算allocatedBytes。因此：

- setup实际arena能跨序列batch复用，不能乘90推resident；
- 并发帧/resize后的pending、cached、不同shape须真实计账；
- 未采实际allocation trace时只报告静态descriptor与上界，不报告已测峰值显存。

## 3. 当前布局精算

依据：[GpuSurfaceCellPlanAbi.ts](../../OEngine/src/gpu/GpuSurfaceCellPlanAbi.ts)、[GpuSurfaceDemandAbi.ts](../../OEngine/src/gpu/GpuSurfaceDemandAbi.ts)、[SurfaceOptimizationCapacity.ts](../../OEngine/src/gpu/SurfaceOptimizationCapacity.ts)、[GpuSurfaceCellGeometryAbi.ts](../../OEngine/src/gpu/GpuSurfaceCellGeometryAbi.ts)。

本次在内存调用这些纯planner（TypeScript转译仅用于静态函数加载，不写build产物、不运行项目build/tests），显式假设maxBuffer=256MiB、storageBinding=128MiB、textureDimension=8192。不是新GPU查询/浏览器limit证明。

### 3.1 Workspace

K=364、R=23296：

| section | offset B | bytes |
|---|---:|---:|
| counters | 0 | 512 |
| plans | 512 | 206752 |
| maps | 207264 | 733824 |
| geometryCertificates | 941088 | 2981888 |
| fieldCertificates | 3922976 | 4845568 |
| persistentCertificates | 8768544 | 4845568 |
| primitives | 13614112 | 93184 |
| addresses | 13707296 | 13418496 |
| fieldReferences | 27125792 | 4193280 |
| signalReferences | 31319072 | 1677312 |
| demands | 32996384 | 372736 |
| facts | 33369120 | 372736 |
| total | — | **33741856** |

公式：W=512+K×(568+2016+64×1408)=512+K×92696，尾facts已按16B对齐。全额clear覆盖容量，不代表全部有效payload都写入。

### 3.2 Demand

F=15R=349440、Q=6R=139776、HF=pow2ceil(2F)=1048576、HQ=pow2ceil(2Q)=524288。

~~~
bytes = align256(512 + 32P + 4(HF+HQ)
                 + 32(F+Q) + 32R)
~~~

32(F+Q)包含16B request及aliases/results/unique/destinations各4B。32R包含三mask、material entry和四queue。P=2得 **22692608B**；preflight按P=256得22700544B。

关键offset：hash从576，field_requests6292032，signal_requests11883072，geometry_masks19990080，field_destinations20362816，geometry_queue22319680，ordered_material_queue22599232；最终含192B padding。

必要reset不是只counter/hash：三mask被atomicOr，compact逐leaf读取；destinations/request refs消费关系需逐项验证。nominate64probe耗尽后resolve目前扫描actual请求流，因此性能最坏不再被probe上限保护。新Phase3/5删除全流fallback，transient仍完整覆盖。

### 3.3 Setup、values、Stores与总账

~~~
D(S) = pow2ceil(max(16, min(65536,4S)))
cost(S) = 64R + 512 + 512S + 8D(S)
S ≤ min(24576,R,floor(bindingLimit/512))
cost(S) ≤ 128R
~~~

实际S=2655、D=16384；setup physical arena=1490432B。planner geometrySetup=1490944B含估算512控制，而实际独立counts32/settings80/indirect16、pool对齐另算。

- GeometryRecord=16773120B；Field values=5591040B；Signal values=2236416B。
- Named imported scratch（Workspace+Demand+record+values+actual indirect576B）=**81035616B≈77.282MiB**，不含FG transient/owner小资源。
- Workspace+Demand clear ×90=5079101760B=**4.730282GiB**。
- FieldStore budget128MiB中扣dependency8MiB，实际entry pool125829120B，262144entries/65536sets；加dependency正好128MiB。
- SignalStore67108096B，190648entries/47662sets，round4ways后比64MiB少768B；生产owner拒绝多segment配置。
- HDR+reactive实际12×2073600=24883200B≈23.730MiB。代码comment写reactive r32float，生产却是rgba8unorm，二者都是4B，容量数字未因此下降。
- 旧planner reservedBytes=**326.797302MiB**，scratch ledger=78.797302MiB；retiredOverlapBytes也报78.797302MiB但未再加进reservedBytes。不能据此证明resize/多in-flight峰值受512MiB约束。
- dependencyOwners预算用256×15×4，而真实按N×15×4创建；P≤256不限制material directory N≤256。Phase1/2必须按真实N计算。

### 3.4 当下overflow和coverage依据

setup容量/probe/CAS失败：slot invalid → cell_ensure_direct_geometry，private单invocation memo；跨consumer仍重复decode，counter105无timing条件且未被快照导出。没有本次fallback量，不将它判作已证主瓶颈。

Demand requests最大15R/6R，unique不超过raw；geometry/material/lighting group≤R。此覆盖成立需每selected代表/field仅emit一次、layout支持完整输入、counter未溢出。当前nominate/resolve的exact全流搜索维护唯一owner，但成本不适用于新设计。

Store4ways满/epoch pinned：不准入，保留transient result；reserved payload后续commit才能read。重构不得把这一正确分支改为漏值或等待他组。

最后batch1080p tile=4（256 padded targets），GPU leaf/extent检查和plan coverage必须保留。R65536新例最后batch656tiles，padded41984targets；active压缩后要映射绝对tile，不能沿旧连续firstTile假设。

## 4. Geometry 14类输入的真实消费矩阵

依据：[appearance_demand_inputs.ts](../../OEngine/src/shaders/appearance_demand_inputs.ts)、[appearance_surface_demand.ts](../../OEngine/src/shaders/appearance_surface_demand.ts)、[SurfaceGeometryPass.ts](../../OEngine/src/render/surface/SurfaceGeometryPass.ts)、[SurfaceLightingWorkPass.ts](../../OEngine/src/render/surface/SurfaceLightingWorkPass.ts)。

C/X/Y指center与相邻一像素实际有限差分位置的值，不是“中心值+解析gradient”。Appearance输入装载受missing output对应inputMasks控制；coordinate preparation对texture/product坐标祖先完整追踪，嵌套texture坐标也不能删邻值。

| kind | semantic / 当前vec4区间 | Appearance读取 | Lighting直接读取 | 新物理分组候选 |
|---|---|---|---|---|
| 1 | uv0，0–2 | 活跃closure C/X/Y | 无 | UV cold |
| 2 | uv1，3–5 | C/X/Y | 无 | UV cold |
| 3 | uv2，6–8 | C/X/Y | 无 | UV cold，primitive-local身份 |
| 4 | vertexColor，9–11 | C/X/Y | 无 | color cold |
| 5 | normal，12–14 | 每点normalize/side flip后C/X/Y | center | center hot，邻点cold |
| 6 | tangent，15–17 | 每点正交化/normalize/flip，C/X/Y | center | frame hot，邻点cold |
| 7 | position，18–20 | C/X/Y | center | center hot，邻点cold |
| 8 | viewDirection，21–23 | 每点camera-position后normalize | center | center hot或已定义廉价计算，邻点cold |
| 9 | cameraPosition，24–26 | 三份同camera transform[3] | 无直接读取 | uniform引用，保留semantic |
| 10 | worldPosition，27–29 | C/X/Y，同kind7 | 无 | 与position共享底层流 |
| 11 | worldNormal，30–32 | C/X/Y，同kind5 | 无 | 与normal共享底层流 |
| 12 | worldTangent，33–35 | C/X/Y，同kind6 | 无 | 与tangent共享底层流 |
| 13 | viewPosition，36–38 | view matrix×position，C/X/Y | 无 | view cold |
| 14 | viewNormal，39–41 | view matrix×normal，C/X/Y | 无 | view cold |

每kind当前48B，共672B；另geometric/identity/metrics各16B，总720B。

Lighting还消费geometric.xyz、identity.x（pixel）、metrics.x（viewDepth）、metrics.y（tangent handedness）。其他identity/z等有不同consumer，不能在物理瘦身时按Lighting独自决定全部保留内容。

96B hot目标尚未自动成立：将Lighting四个center vec4和三个公共vec4原样放热段已经112B，未计cold refs/mask。Phase2应通过共享camera/view数据、紧凑身份引用、实际访问证明达到目标，不能先规定96B再丢数据；128B上限8MiB没有额外控制余量。

kind7/10、5/11、6/12可共享物理storage，但保留独立semantic mask和DAG身份。不能因普通资产两语义当前同值，就错误合并任意自定义graph、Product或未来deformation输入合同。

### 4.1 Continuity / LOD / Product / deformation

| 能力 | 已核对当前事实 | 重构约束/后继 |
|---|---|---|
| 六域 | SurfaceContinuity为geometry/uv0/uv1/normal/tangent/color | DomainRecipe只比较真实依赖；不any-risk擦掉所有域 |
| UV2普通资产 | reader读取值，但无独立chart lineage；address/proof用primitive namespace | Phase1/3相关closure局部限制，不伪造跨primitive共享 |
| 普通coarse LOD | GeometrySurfacePublication按角点lineage交集逐field继承；不唯一则LOD-local | 保留逐field拒绝；不是全部winner必须相等 |
| 属性误差 | 普通LOD沿原attributes，当前attributeError=0 | 只适用于该前提，不代表未来deformation误差0 |
| Product | 实际meshlet triangle后64B/primitive metadata，heap+四banks真实consumer | selected页/source/generation完整；无页不读取占位属性 |
| Product UV2 | GeometryProductResidentAttributes格式无独立authored UV2字段 | 普通UV2路径不代表Product已支持；明确缺省/拒绝相关closure |
| skin/morph | GpuFrameGeometryAttributesAbi要求独立deformation producer；身份含dynamicRevision | revision不证明已产生当前/previous变形属性；Phase2查实接线/合法拒绝 |
| previous deformation | 本GeometryRecord当前无完整previous三值消费链 | 由TemporalFacts/geometry/deformation owner明确事实；不能宣称全矩阵已支持 |
| double-sided/mirror | normal/tangent side flip、sign、world frame已在setup/record中处理 | 每点保留，不以double-sided直接清domain |
| near clip/degenerate | 齐次Winner与值/DX/DY独立有效性 | 当前value有效不代表gradient/support有效，Unknown局部处理 |

相关源码：geometry/SurfaceContinuity.ts、gpu/GeometrySurfacePublication.ts、gpu/GpuFrameGeometryAttributesAbi.ts、shaders/surface_geometry_reader.ts、gpu/GeometryProductResidentAttributes.ts。

## 5. Field 15项的依赖、常量、cache与proof

权威序号：[GpuAppearanceFieldAbi.ts](../../OEngine/src/gpu/GpuAppearanceFieldAbi.ts)；Standard表达式：[StandardAppearanceGraph.ts](../../OEngine/src/material/StandardAppearanceGraph.ts)；任意graph的实际closure必须以compiler DAG为准，不能把本表Standard假设硬编码为全部材质依赖。

| field / width | Standard实际输入 | 缺输出default | 当前消费 / 新profile注意 |
|---|---|---|---|
| 0 baseColor /3 | 参数×vertexColor×baseTexture.rgb | 0 | unlit/compose/F0；stable UV/vertex依赖分别证明 |
| 1 alpha /1 | alpha参数×baseTexture.a | 1 | raster coverage/材质闭包；不能靠后端共享改变coverage |
| 2 metallic /1 | 参数×ORM.b并clamp | 0 | diffuse factor/F0；与ORM共享RGBA query |
| 3 roughness /1 | 参数×ORM.g并clamp | 1 | specular/IBL/normal过滤；roughness阈值非独立证明 |
| 4 occlusion /1 | 独立AO纹理或ORM.r、strength/mix | 1 | Denv compose及specular环境合同 |
| 5 emissive /3 | 参数×emissiveTexture.rgb | 0 | compose；HDR误差不能套固定归一化阈值 |
| 6 normalTS /3 | normal纹理、signed decode、XY scale/product | (0,0,1) | frame变换；方向锥，不按RGB误差 |
| 7 ior /1 | IOR参数 | 1.5 | 当前key/proof包含，但lighting未实际读IOR |
| 8 specularWeight /1 | 参数×specularTexture.a | 1 | F0权重；Normal miss不能重跑命中值 |
| 9 specularColor /3 | 参数×specularColorTexture.rgb | (1,1,1) | F0；实际色域/decode身份保留 |
| 10 coatWeight /1 | 参数×coatTexture.r | 0 | coat enable及base attenuation |
| 11 coatRoughness /1 | 参数×coatTexture.g | 1 | coat BRDF/IBL |
| 12 coatNormalTS /3 | coat normal signed decode、XY scale/product | (0,0,1) | 独立frame/方向变化 |
| 13 normalTSValidity /1 | normal-product有效性或常量 | 1 | 当前控制base normal mapping |
| 14 coatNormalTSValidity /1 | coat-product有效性或常量 | 1 | 当前key/proof含，lighting尚未使用该validity |

### 5.1 当前publication与constant

appearance_material_constants.ts发布mask/exact_mask与15份vec4。有限常量及“已知有限输入×零”可证明数值常量，但signed-zero未知不算IEEE精确。只改变路由，不从原DAG/PSO删真实依赖。无输出default与显式输出constant分开，alpha等默认不替代真实覆盖。

GpuSurfaceFieldIdentityAbi发布每field8u32 descriptor：producer token、value version index、dependency epoch、flags、texture slot offset/count、uvMask等。完整intern输入包含lowered模板、f32 constants、外部runtime值、texture source/content/sampler/decode/transform/fallback、Product对象/field；不能改为短hash相等。

flags标uvLocal/view/world/unknown及14kind mask，动态/nonlocal→unknown。实际Field request依赖：

- 完整20word身份含实例/几何generation、source meshlet/primitive/LOD/chart/side、canonical UV cell、gradient class、geometry/view revision。
- 68word点见证按closure实际启用UV/color/world输入，仍是当前通用88word key。
- cacheable检查dependency epoch、value/DX/DY flags、有效UV/gradient class；并不意味着query廉价。
- support只对当前profile可表示的单parameter domain成立；多chart/world/view不借同一参数证书。
- ValueHit与CertificateHit独立；当前certifiedValue仅在publish证明low=high=payload时置位，不存在通用BoundedDomain近似值命中。
- 新设计的最终closure误差/anchor验证还须Phase3实施，不把旧constant-domain hit写成已完成一般近似cache。

### 5.2 proof支持与实际成本

appearance_field_bounds.ts从同一scalar DAG roots生成bound函数，dependencyProfiles已有inputs/samples/products/dependencyMask/supported。动态/nonlocal仅对应输出Unknown；constant slot和原求值保持一致。

| 类别 | 当前完整数学 | 成本/失败事实 |
|---|---|---|
| 常量/参数 | ab_exact与实际publication值 | 默认可零proof；版本真实变化 |
| attribute | 同源Winner/transform/normalize/side区间 | 当前按leaf/context物化；原geometry域/浮点余量保留 |
| DAG operation | 原interval加减乘除等 | divide跨零、pow非整数或>8、未知操作返回Unknown；不能截断接受 |
| texture | 实际coord/gradient/mip/wrap/filter/summary | 同sample ID在context复用RGBA；不是相同名字就复用 |
| normal-product | 实际moment/decode/validity | 方向无效有正式Unknown/细化 |
| Product | 真实resident page/field与binding | 未覆盖或nonlocal不冒充已证常量 |
| texture-driven/nonlinear UV | 原coord祖先 | 未支持的导数使关联sample输出Unknown，不整材质擦除 |

当前TextureLocalVariationQuery含generation/revision、resident mip、repeat/mirror/clamp、linear halo、交叠mip与node bounds；虽有node计数，尚无最终设计的完整总proof operation/query/visit预算。变量loops必须一起计，DAG节点数不能假装等于GPU指令数。

Phase1补静态cost profile（实际完整DAG ops、unique query、内层visits上界与scratch），Phase3受理预算；本Phase0不凭WGSL文本或Standard表杜撰Dungeon每closure成本值。

## 6. 六类Signal的真实依赖与数值合同

依据：[surface_signal_request.ts](../../OEngine/src/shaders/surface_signal_request.ts)、surface_cell_production_facts::cell_signal_dependencies、SurfaceLightingWorkPass、GpuSurfaceSignalPacketAbi、SurfaceReconstructionPass。

以下是当前fields mask，不是重构后最小公式依赖。需区分shared worker/joint finite guard依赖与正常lobe依赖。

| kind / plane | 当前field dependencies | Geometry / provider | 当前结果及重构决策 |
|---|---|---|---|
| Ddirect 0/15 | 0,2,3,6,8,9,10,11,12,13,14 | position/normal/frame/view、direct cluster/light/sun/VSM | 已着色radiance；正常Lambert分离factor，缩减mask/key/proof；异常guard保留residual |
| Denv 1/16 | 6,13 | shading-normal/environment | 未着色irradiance；compose乘base×(1-metal)×occlusion×AO×1/π |
| Sdirect 2/17 | 0,2,3,6,7,8,9,10,11,12,13,14 | frame/view/position/direct providers | 原specular radiance，metallic常量0可删key依赖0 |
| Senv 3/18 | 0,2,3,6,7,8,9,13 | normal/view/roughness、prefilter/DFG/environment | 原specular environment；metallic常量0可删key依赖0 |
| Cdirect 4/19 | 同Sdirect | coat frame/view/direct providers | coat radiance；shared guard依赖不能按正常coat公式全删 |
| Cenv 5/20 | 10,11,12,14 | coat normal/view/roughness/environment | coat environment独立radiance |

current demand对dirty lighting请求Geometry kinds5/6/7/8，union合并；lit address先强制5/6/7，viewDirection由record生成。

unlit无signal；无direct provider禁用0/2/4；constant coat≤0禁用4/5。Sdirect/Senv metallic=0的依赖缩减必须是可读publication事实，不能靠未求值transient猜值。

Signal key72word涵盖kind/provider revisions、几何/实例/source/side、normal/position/view见证和实际FieldRef。Denv不加view revision，direct含pixel/shadow内容namespace；provider版本分离，不能一律camera变化清FieldStore。

FieldRef先固定：Store→immutable slot/generation，Publication→producer/version。Transient阻止持久准入，每帧index/generation不能伪造跨帧稳定身份。

### 6.1 颜色、能量和finite

- 当前signal/field为曝光无关linear Rec.709；reconstruct最终Rec709→Rec2020并preExposure一次。
- Denv只输出irradiance，base/metal/occlusion/AO/1/π在compose一次；emissive单独合成。
- 当前Ddirect为colored residual，不再乘一次颜色；transport必须整体切换key/proof/worker/store/compose。
- coat attenuation与coat radiance分开积累，不再次乘attenuation或按总specular分配coat。
- re_direct_physical对合计contribution作finite拒绝；正常实数分离不代表异常IEEE路径等价或逐位相等。
- packet_store的semantic参数当前没有写入payload；按kind/固定合同解释。flags常量存在不证明标志真实发布，Phase5为transport/residual建立实际可读semantic。
- reconstruct alpha是valid coverage，非透明layer/alpha-blend完整链证明；透明仍独立composition。

### 6.2 已有缺口与责任阶段

| 缺口/差异 | 当前事实 | 后继处理 |
|---|---|---|
| IOR消费 | surface_material不读field7，F0固定0.04后mix albedo/metal并乘weight/color | Phase1明确原PBR/profile合同，Phase5真实消费/支持范围检查，不因key含IOR宣称完整 |
| coat validity | field14在key/proof但worker不读；field13控制base mapping | Phase1/4依赖与拒绝规则，Phase5实际消费/数值对照 |
| transport guard | 原guard检查合计贡献 | Phase5有限profile/异常ColoredResidual，key/semantic真实连通 |
| transient Signal | Field生产前真实值身份未知 | Phase3/4保持dirty，不搬到Field binding前沿用旧identity |
| bounded cache | 当前certifiedValue仅常量域 | Phase3最终closure/anchor误差，不假称已实现一般近似cache |

这些为Phase0现状差距，本阶段不改BRDF或猜收益；必须进入后续检查，不能随物理重排隐藏。

## 7. 最终预算的可装入性与布局约束

以下是面向Phase1/2的容量可行示例，非稳定ABI，不要求consumer服从臆定字段尺寸。

R=65536、K=1024、full extent B=32；所有coarse source来自真实leaf，geometry union最多R，不为每plane再分R份。

| 类别 | 可行例 /预算 | 实施需核定 |
|---|---|---|
| plans/control | ActiveTileList129600B；frame headers若32B/T≈1MiB；batch模板/PSO/indirect合计≤8MiB | 不把21plane map变full-frame65MiB |
| setup | local512R=32MiB、memo8MiB、目录/ref/sort/control≤8MiB，共48 | memo/local区间明确，memo满仅拒绝优化 |
| candidate/proof | address96R=6MiB；proof256×R/2=8MiB；meta32×R/2=1MiB；witness192R=12MiB；control1MiB，**28≤32MiB** | 192B非14kind通用witness，复杂类走Transient/Geometry cold，不裁身份 |
| Geometry hot | 128R=8MiB | 96B目标未闭合，128B须含ref/mask |
| Geometry cold | 720R=45MiB，48MiB余3 | 完整旧语义最坏兜底，真实profile/offset计账 |
| Field values | 15×16R=15MiB，16MiB池 | CSE组织不另分同等副本 |
| Signal values | 6×16R=6MiB，8MiB池 | semantic/meta/spill≤2MiB，f32不另叠完整spill |
| demand/refs/maps | §7.1上界**25.96875≤32MiB** | admission限R/2，不沿旧九组全量arena |
| FieldStore | 128MiB含dependency/cert/管理 | 不entries128再藏deps8 |
| SignalStore | 64MiB完整key/payload/维护 | semantic变化不可无账扩池 |
| variation | 32MiB | summary装不下则明确unknown |
| output | 24MiB，1080p实际23.730 | format/extent/lifetime明确 |
| retire/alignment | 64MiB | 不能覆盖整套约200MiB新scratch双份退休 |
| 合计 | **512MiB：active448+headroom64** | 旧/新/pending/cached真实对象各计一次 |

### 7.1 Ref/map/demand保守上界

罕见mixed即使需逐leaf独立ref，仍可装入：

| 项目 | bytes |
|---|---:|
| 21 refs×12R | 16515072 |
| 三owner mask×4R | 786432 |
| geometry slot remap×4R | 262144 |
| 三worker queues×4R | 786432 |
| material order×4R | 262144 |
| admission handles×16×R/2 | 524288 |
| admission hash×4R | 262144 |
| alias×4×R/2 | 131072 |
| destinations×21×4R | 5505024 |
| batch mixed双map×21×96K | 2064384 |
| program/control | 65536 |
| indirect | 65536 |
| total | **27230208B=25.96875MiB** |

这是容量预留，不让common implicit/constant逐项初始化/ref写入，也不默认全字段去重。更紧凑表示可少分；新增表必须在余量6.03125MiB内计，不无账借池。

admission R/2可拒绝优化，mandatory geometry/field/signal池保证完整fine。proof拒绝不产生另一个超容量fine queue；mask/template默认fine，coarse完整reservation后发布，写域互斥。

### 7.2 Limits与物理scope

| 当前kernel | storage buffers / groups | 核对点 |
|---|---:|---|
| cell普通/Product | 11/16，3groups | Product额外heap+四banks，显式layout不能按未读省统计 |
| setup普通/Product | build6/11，2groups | auto每entry布局不同，BG不任意复用 |
| Field/Signal lookup | 4/5，1group | Signal另shadow |
| demand | 5，1group | indirect独立，非writable arena |
| GeometryRecord | 3，1group | camera为uniform |
| Appearance | base6，额外texture/Product依compiler | registry按实际layout preflight |
| Lighting | 12，4groups | group0七+group1四+group3page一，另uniform/texture限 |
| Store publish | 7，1group | workspace/metadata/version/arena/Store/values/shadow |
| reconstruct | 9，1group；另2storage textures | planner和consumer不同scope |

RendererCore目前要求core-features-and-limits、indirect-first-instance、texture-formats-tier1、WGSL unrestricted_pointer_parameters；optional subgroups/primitive-index/timestamp-query核对后请求。requiredLimits至少16storage buffers，当前请求adapter buffer/storage最大值；这不证明任意浏览器只用baseline128MiB即可跑所有组合。

新profile核算groups/bindings、uniform/dynamic alignment、storage/sampled textures、每维dispatch、workgroup storage/invocations。R/64=1024组，1080pcoverage32400组均低于65535的一维上限；大extent需分维/缩batch。

CellLaneGeometry112B×64=7168，SurfaceCellLane32B×64=2048，classifier五数组+state1296，合计10512B；certificate诊断数组另1792，published keys另256。此声明上界12560B不是每entry实际可达占用或新shader compiler验证。

private setup/attribute/texture arrays不占workgroup但可能导致寄存器/spill/编译成本。新分组共享区只放key/lane、prefix和当前组compact facts，不放64×512setup/21plane大proof；Phase2/4按实际生成WGSL验limit。

compute每dispatch一个usage scope，copy/clear/query在pass外。不同range不自动合法；indirect写完后另dispatch读，读时不同时绑定其writable storage。uniform沿encoder staging顺序，不改为同submit前queue.writeBuffer反复覆盖同地址。

### 7.3 Phase 0 容量结论

R65536/32batch/512MiB存在可行字节示例，尚非新ABI/分配或性能验证通过。consumer完整能力不因压缩丢失，旧128/720预算类别不直接当新hot/cold。

已固定后继约束：N/PSO分开、local不依赖memo、proof/admission与mandatory容量分开、身份完整、hot包含refs、近似误差合成、retired overlap创建前计账。Phase1/2就地实现并检查，不提前造稳定spec。

## 8. Reset、删除边界与真实切换单元

| 数据 | 当前初始化依赖 | 替换时必需动作 |
|---|---|---|
| plans/maps | 当前packed OR和部分写依赖zero | 每mode完整写或reset真正OR域，消费者只读取已发布mode |
| persistent cert masks | known/field mask在50/51先load再OR | 清/整体覆盖新mask，不继承旧batch |
| three demand masks | atomicOr后compact每leaf读 | reset所有可能消费leaf或epoch有效性；不能只clearcounter/hash |
| hash/owner | Empty、0/request+1、invalid等编码不同 | producer和consumer同切换，完整table初始化/生命周期 |
| Address | invalid/部分field未写 | valid与input mask保证，读未启用payload不得“默认以前clear过” |
| value/ref/destination | actualCount内写，多个closure引用不同destination | 完整source绑定/count先发布，generation/tag对应 |
| zero indirect | 上批非零可能残留 | producer全部xyz/count写，实际0工作不沿旧args |
| outputs | background/Surface覆盖 | 每像素单完整写域，coarse/fine reservation互斥 |
| reused memo/cache | epoch/generation/pin | namespace不wrap成旧身份，payload不可原地变成另一Published值 |

必删执行负担及对应原数学：

- surface_cell_classify::前序member搜索、各candidate重复collect/member、lane0 representative搜索 → 固定4-child树/source直接映射。
- surface_cell_lighting_risk::member/前序primitive去重 → setup显式ref；direct provider风险按候选复用/上限。
- surface_cell_production_facts::cell_direct_key/cell_direct_setup/cell_ensure_direct_geometry及访问helper fallback → Geometry owner guaranteed local producer。保留cell_build_geometry_setup/Winner/属性变换数学。
- surface_cell_addresses::576B统一产品 → cheap候选与受理lazy witness；不是删真实gradient/side/filter输入。
- surface_cell_certificates::所有leaf/family常态生产 → admitted profile queues；保留interval Unknown/支持域/舍入。
- surface_demand::强制所有完整key interning、probe失败全流扫描 → template/mask、选择性bounded admission、失败transient。
- Workspace/Demand整块clear → reset表；不撤销必要mask/hash状态。
- repeated BG/pipeline encode → 兼容layout/resource generation cache及合法dispatch scope。

| 切换单元 | producer和必须同时迁移的直接consumer | 负责阶段 |
|---|---|---|
| publication/profile | GpuAppearancePublication/field identity/compiler → facts/request/lookup/proof/demand | Phase1，必要后继consumer前移 |
| setup/address/record | Geometry owner → appearance_surface_demand、Lighting、所有proof/witness accessor | Phase2；不能保留720B适配器跨阶段 |
| candidate/value/cert | lookup/proof/publish → ref reader/field plan/source | Phase3 |
| fixed tree/source | Field plan → Signal identity/plan、demand/remap/reconstruct selection | Phase4 |
| Ddirect语义 | dependencies/key/proof/worker/Store → compose | Phase5 |
| reset/pool/indirect | capacity/resource lifetime → 全producer/consumer/encoder | Phase2/6，不将异常留Phase7 |

阶段闭合要求按新执行计划§1：跨阶段必要consumer前移，阶段收口编译与真实小链检查，不能以旧链、adapter、空consumer或占位值通过。

## 9. 固定来源与本次数学复用核对

来源完整映射见[porting ledger](../porting/next-renderer.md)，本次没有运行donor工程、GPU验证或提升adoption。

| 来源 / revision /许可 | 本次核读 | 本地复用、关键分支与适配 |
|---|---|---|
| Forge cd5046893faba2dc7869243873bf01f02a6f0df9 /Apache-2.0 | 完整VisibilityBufferShadingUtilities.h.fsl；固定raw与本机9406字符一致，文件许可头 | CalcFullBary/Interpolate2DWithDeriv→原Winner/setup/address/record；保留一像素投影差分；本地齐次零/负W扩展不退回直接1/W |
| CPS 63ad5c1adafbfcc2869a200f50a5ea11f28b4887 /Apache-2.0 | 完整ComputeShaderTile.hlsl，固定raw与本机13298字符一致 | coarse/full、边界/无灯/DEFER补做参考；已有GBuffer输入不能当本地免费事实或完整前置证明 |
| OSS 473a59bbcdd30e3366cc567d66a5a97353620d48 /Apache-2.0 | 完整RenderTaskProcessing.compute，固定raw与本机3453字符一致；本次重新访问根License | occupancy→task/count/offset→indirect参考；原AllocateTask没有本地所需完整capacity check，不能把bounded overflow归给donor |
| Microsoft 1ad8f0f6a3e4d9be7e54ca52640ac12b6565ab0c /MIT | 完整ComputeShaderSort11.hlsl、host GPUSort level/transpose/readback、根LICENSE | 64-key本地workgroup分组，level2..64、比较交换前后uniform barrier、key/lane/valid；不移植全帧transpose/CPU回读 |
| 本地DAG/interval/TextureVariation | 原instructions、constant slots、sample/productID、Unknown分支及filter/wrap/mip | profile/cost准入是本地复杂扩展，不冒充完整upstream port |
| 本地生产Lighting/原Filament数学 | 当前Lambert/coat/specular/IBL/finite及真实worker消费 | Ddirect代数分离须完整保留异常与provider语义，IOR/validity缺口单列 |

本机字节SHA256：Forge=9b567bf3dc106398b6462418c6457a953d2f5dc4fd797d388c50d4aec4af1d1c；CPS=bf8d9ff071965457779184bca8dc1d67c0381d0183e2f97283ea0a2142c6d2c9；OSS=523ab05a538f6366d88e83e94fd022ea70c206751f2470a00a93549f54d6cdab。字符一致性与文件字节hash分别记录，不将编码差异解释成算法变化。

论文/详细资料沿用账本既有DAIS§3–4/§6/Appendix A、OSS preprint和CPS GPU Pro7 README；本次核对本机PDF存在，未重读PDF全文，不新增论文收益/实验声明。复杂实际实施前按采用的具体阶段继续补核依赖，并在相应阶段运行WGSL/CPU对照和真实生产消费。

Winner当前共同比例归一化齐次(x,y,w)，value/DX/DY各自有效；不因footprint奇点抹掉合法visible value。Field identity原完整f32 DAG/JSON interning含sampler/decode/transform/channel/range/domain，未版本化source仅session身份；不能用portable=false的对象构造跨进程稳定缓存。

## 10. Phase 0 检查结果与后继

本阶段检查针对静态事实/清单，未运行生产typecheck/build/tests/browser/benchmark，不将其他阶段的代码检查提前标通过。

| 检查 | 结果 |
|---|---|
| 起始HEAD/clean、生产14c17078到HEAD差异 | 核对；生产源码/Showcase/lab无差异 |
| 历史613源码/资产/报告hash | 一致；历史accepted=false保留 |
| 当前物理layout/pool formulas | 直接调用现有纯planner，得到33741856/22692608B、23296targets/90batch |
| 新预算静态example | 512MiB合计；mandatory/ref/address例在各池内，未冒充新ABI |
| 14kind/15field/6signal consumer | 完整矩阵和现状gap登记，source引用可定位 |
| overflow/reset/usage/retire | 逐产品登记，已识别mask、full-flow fallback、N/P、retirement风险 |
| 固定donor及本地数学范围 | 完整源码及许可证核对范围明确，无adoption提升 |
| 文档链接/YAML/vibe导航 | 收口时静态核对并记录于progress |

Phase0完成意味着重构输入与风险已被核清，**不意味着当前800ms已修复**。下一步仅在用户要求进入Phase1后，落实publication/profile/工作表示及真实直接consumer，按阶段检查表通过后推进。

后继必带问题：

1. N与P容量区别和actual buffer账在Phase1/2实现，不复制旧planner估算。
2. hot96B尚未物理核定；保留完整语义，Phase2实际layout+consumer验证。
3. 新proof budget、一般BoundedDomain/复合误差、选择性dedup尚未实现。
4. skin/morph/previous、Product UV2/页缺口不能靠版本数字填成已支持。
5. IOR/coat validity/semantic消费差距按阶段修复或明确支持边界，完整功能目标不隐藏。
6. pending/cached/resize overlap与真实device limits按Phase2/6收口，不以512MiB分类和单buffer≤128MiB冒充全部正确。
