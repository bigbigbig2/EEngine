---
id: eengine-v4-vt-transport-transcode-execution-2026-10
state: history
supersededBy: eengine-extreme-web-asset-compression-execution-2026-10.md
verifies:
  files:
    - docs/next-design/eengine-v4-vt-transport-transcode-2026-10.md
    - docs/porting/next-renderer.md
    - OEngine/src/assets/TiledTextureProduct.ts
    - OEngine/src/assets/TiledTextureSource.ts
    - OEngine/src/assets/codec/TiledTextureCook.ts
    - OEngine/src/assets/codec/TiledTextureTransport.ts
    - OEngine/src/assets/codec/TiledTextureCompression.ts
    - OEngine/src/assets/codec/TiledTextureDecoder.ts
    - OEngine/src/assets/codec/vendor/tiled-zstd
    - OEngine/tools/texture-codec/TiledZstd.c
    - OEngine/tools/build-tiled-texture-codec.mjs
    - OEngine/tools/benchmark-tiled-texture.mjs
    - OEngine/vite.config.ts
    - OEngine/src/assets/codec/TiledTextureCache.ts
    - OEngine/src/assets/codec/CookedAssetPreparation.ts
    - OEngine/src/assets/codec/CookedAssetProtocol.ts
    - OEngine/src/assets/codec/AssetWorkerPool.ts
    - OEngine/src/assets/codec/workers/cooked-asset-worker.ts
    - OEngine/tools/cook-offline-scene.mjs
    - OEngine/tools/build-pc-texture-codec.mjs
    - tools/test-build.mjs
    - OEngine/src/gpu/VirtualTextureAbi.ts
    - OEngine/src/gpu/VirtualTextureResidency.ts
    - OEngine/src/gpu/TextureResidency.ts
    - OEngine/src/framegraph/ShadeGPUCommandContext.ts
    - OEngine/src/render/program/FrameProgramLowering.ts
    - OEngine/tests/unit/tiled-texture-product.test.mjs
    - OEngine/tests/contract/tiled-texture-worker.test.mjs
    - OEngine/tests/contract/virtual-texture-residency.test.mjs
    - OEngine/tests/oracle/streaming-vt-gpu.mjs
    - OEngine/tests/oracle/scgi-query-vt-gpu.mjs
    - examples/integrated/dungeon-warkarma-texture-compression/cooked-scene.ts
    - examples/integrated/bistro-texture-compression/cooked-scene.ts
    - project/workstreams/active/eengine-next-clean-rebuild.yaml
---

# VT 细页无损传输压缩执行文档

2026-10-20 后续授权说明：本文保留已完成模块的实施、验证、成本与未运行范围，不再作为新模块执行入口。当前计划见[极致 Web 资产压缩执行](eengine-extreme-web-asset-compression-execution-2026-10.md)；旧结果不被追认为新方案结果。

唯一详细目标为[设计文档](../next-design/eengine-v4-vt-transport-transcode-2026-10.md)。本版已明确选择 **BC 细页逐页 Zstd → 现有 Worker 解压 → 原有 VT 上传事务**，不再安排泛泛的候选技术研究，也不实施图片解码和 GPU 重编码。

当前状态：**两项均完成实现与本模块直接验证，见 §7；已停在模块边界。** 用户明确授权第一、第二单元后，schema 2 / Worker 协议 3 已单路径切换。全 Renderer 大场景镜头轨迹、跨设备画质/正式 FPS 资格仍属最终集成，不在本模块伪称通过。SCGI 原实施与未完成 SCGI-10 资格保留，workstream 按此次授权导航本模块，不自动恢复其它模块。

## 1. 工程量与执行组织

这不是重写 VT，也不是新增一个 GPU 算法模块。主要工作量在分块产品、离线复用、Worker 回执和 CPU 信用/缓存；shader、页表和 Native 采样原则上不改。

按真实工程闭包分成两项：

| 工作项 | 内容 | 稳定边界 | 当前状态 |
| --- | --- | --- | --- |
| 一、完成单路径产品重构 | 轻量解压器、schema 2、Cooker、离线工具、Worker 协议、信用、缓存和全部直接读者连续修改 | 新产品从生成到现有 GPU 消费完全连通，旧 schema 生产支持已删除 | 已完成，§7.1 |
| 二、集中验证与修正收口 | 独立无损/恶意输入、真实 Worker/缓存/生命周期、生产 VT/SCGI 接线和必要成本 | 实际错误修复，直接相关验证与成本结论留存，模块关闭或有据否决 | 已完成本模块收口，§7.2–7.5 |

第一项中的文件任务是实现顺序，不是要逐个申请批准或拆成十几个验收阶段。实施期间允许暂时断链；完成一个原子单元后只有一套生产合同。若用户授权连续完成整个模块，两项连续推进，不在每个 helper 或测试前停下；结束停在本模块边界，不自动进入其它效果。

Git 用于回退。不做新旧并跑、逐消费者迁移、临时 adapter、失败时切旧细页编码或双格式资产部署。必要对照是离线/测试中的独立原生 BC 参考，不是保留旧生产实现。

## 2. 开始实施时一次核对

读取当时的工作流、目标设计和相关目录约束，并运行：

```powershell
node tools/vibe.mjs context OEngine/src/assets/codec/TiledTextureTransport.ts
node tools/vibe.mjs context OEngine/src/gpu/VirtualTextureResidency.ts
git status --short
```

确认代码仍具备：schema 1 分块目录、同一 Worker 池/信用系统、BC ready 租约和现有帧内上传事务。如果已变化，局部修订本设计与文件映射，不机械套用本轮行号。保留用户既有改动，不清理无关工作区。

读取当前已固定 Basis revision 的 `zstd/`，核对版本、完整源码与 BSD 许可；沿现有 vendor 构建身份机制生成独立 decoder。这里不是重新开放 AVIF/WebP/Spark 选型。现有试算提供方向依据，但真实浏览器成本仍需本模块收口验证。

## 3. 工作项一：连续完成完整产品闭包

### 3.1 固定实现边界

| 位置 | 具体修改 | 必须同时清掉的旧假设 |
| --- | --- | --- |
| `TiledTextureProduct.ts` | schema/recipe 2；目录级固定 Zstd 配置；payload encoding/nativeByteLength；细页、尾页和 resident 用途交叉验证 | 所有虚拟 payload 的磁盘长度恒等于 BC 页长度；schema 1 兼容 |
| `TiledTextureCook.ts` | 细页最终 `#region` BC 后固定压缩；tail/resident 原样；写两种长度和传输 hash | `#write` 只有一种表示；异步处理借用 mip 缓冲区可能越过回调生命周期 |
| 固定 Zstd 包装及构建入口 | 原版 `zstddeclib.c`、本地有界 C 接口、独立 4 MiB 固定 WASM、二进制/source/license 清单 | 不能调用整个 Basis 编码器替代轻量解压器；不能让 WASM 无界增长 |
| `cook-offline-scene.mjs` | 按 schema/recipe/profile/编码器身份检查复用；新 pack/shard 和收据；旧分块重建可复用原完整 BC 产品 | 只比 addresses/residentRoles 就复用；用压缩长度校验原生字节；所有 runtime codec 工作都等于零的旧统计 |
| `TiledTextureTransport.ts` | 仍按传输长度合并/读取/hash；Worker 内严格单帧解压；返回精确原生数组 | 压缩页返回数组长度等于 byteLength；先构造所有压缩副本再解压 |
| `CookedAssetProtocol.ts` 与 Worker | 协议 3 原子切换；表示明确的原生回执；固定模块惰性初始化；重启重新注册 | 旧协议判断、无输出域声明的回执和假品牌 |
| `CookedAssetPreparation.ts` | S/E/D 分账；输入/输出原子信用；验证原生回执；模块预留与统计；取消结算 | 用同一长度计算输入与 ready；`span.byteLength*4` 默认能覆盖所有展开 |
| `TiledTextureCache.ts` 和 `TiledTextureSource.ts` | 缓存明确为原生 BC；命中直接交付；release 转移并失效；GPU 无感知 | 同一缓存键可能装压缩帧或 BC；release 把 BC 错当编码缓存 |
| 实际材质加载入口与测试 helper | 新目录/收据和正确的“目录阶段无解压、细页阶段有 Zstd”描述 | 旧 fixture 直接把磁盘细页当 GPU BC；无条件宣称全部 cooked 读取无 codec |

目标文件可以局部新增，如单一 `TiledTextureCompression` helper、轻量 decoder 包装和构建脚本；不强制拆类，不新增框架和公共 API。源码实际命名以最小清晰闭包为准，不能把这些位置表演化成新的层级。

### 3.2 实现顺序与约束

先把表示合同、压缩入口和受限解压器建立起来，再连续贯通 Cooker/离线工具及 Worker/信用/缓存，最后将所有读者与 fixture 同时切到新表示。此期间不建立生产双版本分支。设计中确定的源 mip、BC 编码、边框生成、强制常驻闭包和尾页位置全部保留。

新的 decoder 必须一次实现完整单帧检查：普通帧、精确内容长度、窗口、无字典、有校验和、完整帧长度、固定输出容量及错误返回。静态 DCtx 和逐页输入/输出工作区在固定内存内复用；任务取消后不能继续向新 Worker 实例发布。

CPU 信用改造先按完整请求的 `2S+2D` 预留，再以真实所有权收缩；单 Worker 常驻 4 MiB 从总额中单独预留，不和瞬态账户混淆。缓存 hit/miss 混合、一个批次部分页被 VT 放弃、取消与 Worker 抛错，都必须有一个幂等终结路径。新的统计至少区分：实际下载、有效压缩输入、解压原生输出、缓存命中字节、解压 CPU、模块初始化、ready/cache/模块内存与峰值。

原 `VirtualTextureResidency.copyTile` 保持接收完整 BC；不删除它、不把它改成读 Zstd、不新建 compute。复核 `pump` 未消费租约的容量归属、上传预算与主视图/query 需求不变。若出现现有真实遗漏，只在此 owner 修复与本次闭包直接有关的错误，不扩大重写页调度。

`FrameProgramLowering`、Native shader、VSM coverage 与 SCGI 只核对真实直接消费；无必要不改。如果实际发现必须变 ABI，必须与全部直接消费者在本单元同时闭合，不能留旧接口桥。

### 3.3 删除与保留清单

删除 schema 1 生产读取支持、原生 fine payload 的产品生成分支、旧长度等式和仅验证这些表示的旧测试断言。删除/迁移表示测试不等于删掉语义测试。

保留唯一最终 BC 页生成和上传；保留普通 TextureProduct、原生 resident/tail、R8 精确覆盖及实际 coverage 依赖平面；保留 feedback、LOD/导数、NPOT、query 公平性、槽位 generation、publication/abort/retry/loss。它们不是等待慢慢迁移的旧路径，而是新产品直接使用的存活架构。

开发中只在需要时 typecheck、编译 decoder 或运行极小 oracle，不每次修改跑整个 Renderer。单元末先修真实编译失败，形成完整连通的新闭包，再进入集中验证。

## 4. 工作项二：架构复核、直接验证与成本裁决

### 4.1 一次架构复核

核对从离线最终 BC 页到真实 GPU 采样的全部直接边界：身份、两种长度、hash、输出表示、信用、缓存、取消、source 退休、帧提交和 staging fence。确认无第二 owner、无通用 codec selector、无 GPU 重编码、无新增 submit；未知/损坏产品明确失败，不吞异常。

同时审查首次加载、cache hit、source 替换和 device restore。设备无关 BC 缓存与 GPU epoch 分离；session 退休不能把旧租约入缓存，合法独立缓存也不因 device loss 无端重下载。已提交通知异常与提交前 abort 分开结算，不能“回滚”已提交 atlas 写入。

### 4.2 最小独立检查矩阵

| 检查面 | 必须覆盖 | 证据等级与范围 |
| --- | --- | --- |
| 原生字节 | BC7 sRGB、BC7 linear normal/ORM、BC4；clamp/repeat/mirror、NPOT、内区/边缘、末个细 mip 与尾页 | 原有冷 BC 参考与新压缩往返逐字节一致；不通过放宽颜色/normal 容差 |
| 目录 | 错 encoding/用途、native 长度、传输上界、重复/孤儿、resident 片段、尾页共享、旧 schema | 直接拒绝错误产品，不建立自动兼容 |
| 解压器 | 截断、错误校验和、长度/窗口不符、字典、未知长度、拼接/跳过帧、尾随垃圾、高熵可略膨胀页 | 真实固定 WASM 对照 Node Zstd 参考，固定内存内失败，不按帧声明任意分配 |
| 真实 Worker | 首次模块初始化、原生 bootstrap 不初始化、混合 hit/miss、Range/shard、主线程回执来源及输出域 | 用实际 Worker 执行，不以全部 mocked fetch/decoder 代替 |
| 信用/缓存 | 压缩小而输出大的批次、最大合法请求、budget 太小、release 视图失效、重复 release、部分放弃 | CPU 信用、实际 backing、模块预留、缓存峰值和释放回到基线 |
| 取消/恢复 | 排队和执行取消、Worker crash/replacement、目录/session 退休、旧结果迟到、重试 | 不发布旧身份、不漏信用、不在销毁后复活任务 |
| 真实 VT GPU 消费 | 原生 bootstrap 后真实压缩细页替换；atlas layer>0、跨槽、victim、上传 abort/retry、fence 退休 | 从新 Worker 到原有 BC atlas 和真实 Native 采样，不以独立解压成功替代接线 |
| query 消费 | query-only 缺页、主/query 共同需求、mapping candidate abort 与提交修订 | 现有 SCGI 材质使用新细页，原失效/公平性不丢失 |

不是重跑所有未修改的纹理/VT 数学矩阵。先把上述输入纳入现有窄入口：

- `tests/unit/tiled-texture-product.test.mjs`：把当前“磁盘页就是 BC”的断言改成解压后的原生字节断言，保留所有现有内区/gutter/tail 语义。
- `tests/contract/tiled-texture-worker.test.mjs`：扩展真实 Worker、缓存与取消；helper 随新协议切换，不能只改 mock。
- `tests/contract/virtual-texture-residency.test.mjs`：原生 ready 合同、容量和事务，必要时补新长度统计。
- `tests/oracle/streaming-vt-gpu.mjs`：输入接新分块产品/真实准备链，保留多 layer、槽位和生命周期；不写一套仅测试专用生产捷径。
- `tests/oracle/scgi-query-vt-gpu.mjs`：补实际压缩细页的 query 消费与 revision；没有修改 query 数学时不重跑整套 GI 算法。

目标命令以实施时真实入口为准，基本收口顺序为：

```powershell
npm --prefix OEngine run typecheck
npm --prefix OEngine run build:test
# 在 OEngine 工作目录中执行；新 decoder oracle 加入同一直接相关集合。
node --test tests/unit/tiled-texture-product.test.mjs tests/contract/tiled-texture-worker.test.mjs tests/contract/virtual-texture-residency.test.mjs
```

GPU 作业串行，使用实际验证宿主运行选定的两个直接 oracle；不凭空发明未存在的 runner 命令。新鲜 build:test 在基本连通后集中运行，不能复用 source identity 已失效的 `.test-dist`。需要部署接线时补 engine build；本轮设计改动不要求运行这些代码检查。

保留原失败并按验证合同分类，局部修复后只重跑受影响项。旧表示测试退休，不恢复旧架构来取悦测试；真实字节、导数/LOD、normal、HDR、覆盖、唯一 writer、原子发布与生命周期语义不能删。

### 4.3 成本与实际价值

以现有允许的 Dungeon/Bistro 产物和一份覆盖缺少语义的真实页样本检查，不自动使用用户排除的旧大资产。记录样本来源、产品/配方 hash、语义分布，不把本轮全 ORM 试算包装成全材质覆盖。

集中报告：

| 维度 | 报告口径 |
| --- | --- |
| 字节 | 原生有效 BC、压缩有效字节、实际 HTTP/过取、目录与启动原生字节，pack/shard/完整产品磁盘复制分列 |
| CPU | 冷模块加载/编译、hash、解压、WASM 输入/输出复制、队列等待与 ready P50/P95；不要只报解压内核 |
| 内存 | 每实际 Worker 线性内存、加载瞬态、范围 body、输出/交接、ready/cache、替换峰值；浏览器不可测内部内存单列未知 |
| GPU | 相同页数下 BC 上传和采样结果不变，新增 compute/pass/submit 为 0；实际接线计数验证，不靠文档断言 |
| 负载 | 冷读取、缓存命中、带宽充足/受限网络、镜头移动压力和无需求静帧；分别看 IO 节省与解压税 |

性能对照使用同一最终 BC 页与相同请求序列；可在独立测量工具中生成原生参考响应，不把参考服务/旧产品加载器放回生产。先测真实全闭包，不为每个内部 patch 建一份 benchmark/evidence/claim。网络节省目标不是测试阈值，不预设 35%/50% 或按结果倒推容差。

本方案已经确定，待测的是适用收益与参数，不是再次由执行者在 AVIF/WebP/Basis/Spark 中选路。若 WASM 冷启动/CPU 税或实际压缩分布证伪收益，应保留结果并整体修订/否决，而非加动态 fallback 或降低质量。大胆重构不等于必须提交不值得的优化。

## 5. 完成记录与停止边界

闭合后在本文件直接记录：实际代码身份、切换/删除文件、decoder/source/build 身份、通过与未运行检查、原失败及修复、真实字节/延迟/内存结果。设计目标与已实现事实分开，`docs/domains/` 仅在源码真实切换后更新；已有 VT/Texture 文档中受影响的“运行时无 codec”陈述应限定为普通 BC 产品/原生 bootstrap，而不能继续概括整个细页读取。

改动文档后运行根目录 `node tools/docs-verify.mjs`。按需要在已有来源账本记录准确复用范围；来源核对、独立 oracle 与真实新生产消费齐备后才能提升采用身份。没有测过就写未运行，不以 byte round-trip 宣称浏览器生产通过、GPU 提速或整 Renderer FPS 资格。

最后停在本模块边界。是否把它设为工作流当前模块由用户的实际启动授权决定，不由新增文档自动决定。

## 6. 设计修订阶段历史记录（2026-10-20，实施前）

- 已重新核读产品、Cooker、离线复用、真实 Worker、信用/缓存、VT 主/query 调度、原生 bootstrap 和帧命令提交相关实现。
- 已核读固定 Spark JS 与 BC7/BC4 WGSL 的实际输入、stride、dispatch、submit 和许可边界；没有复制其 shader 或声称采用。
- 已核读固定 Basis checkout 中 Zstd 1.5.7 的头文件、帧检查、静态上下文与多帧/单次解压路径；选定轻量独立 WASM 的目标接法，尚未生成新二进制。
- 已对 25 个现有目录的 8,525 个 ORM BC7 细页完成独立 hash/压缩/逐字节往返；最终开启帧校验和后由 176,774,400 B 变为 69,376,478 B，约减少 60.75%。样本不覆盖颜色/normal/BC4；不是浏览器延迟或生产性能证据。
- **当时**未修改生产 TypeScript/WGSL/构建脚本，未运行生产 build、浏览器或 GPU 验证，两项尚未开始。本段仅保留设计阶段事实；随后用户授权的实施结果以 §7 为准。
- 文档检查：`node tools/docs-verify.mjs` 为 0 项问题、71 项历史警告；已检查两份文档的正文语言及行尾空白，`git diff --check` 通过。历史警告不是本模块运行时验证，也未为此改动无关历史文档。


## 7. 实施与集中验证记录（2026-10-20）

### 7.1 已完成的原子切换与架构复核

代码从设计提交 `b851d895` 的干净工作区实施；此记录对应本次未提交工作区，不虚构新 commit 身份。用户连续授权两项后完成：

- `TiledTextureProduct/TiledTextureCompression`：目录/recipe 2，固定 Zstd 配置，传输 hash/offset/长度和原生长度分离；fine 仅 Zstd，tail/resident 仅 native；旧 schema 明确要求 recook。完整 source/mip/topology、引用唯一性、尾页共享、coverage 和 pack 连续域校验保留。
- `TiledTextureCook/cook-offline-scene`：最终 BC 页后压缩，原 mip/边界条带/覆盖不变；收据按 schema/profile/Node-Zstd 身份决定复用。旧收据重建 tiled 可复用认证完整 BC Product；声称新版本但实际目录/pack/hash 错误属于损坏，明确失败而非悄悄覆盖。统计单列传输和 native。未保留旧 fine 格式分支。
- `TiledTextureDecoder/TiledZstd.c`：单 Worker 惰性、顺序页解压；原上游帧算法不改。普通单帧、内容长度、窗口、无字典、有 checksum、完整帧边界全部检查；无增长 4 MiB，静态 DCtx 256 KiB、输入/输出工作区与 256 KiB stack 均在此内。输出 slice 成独占 BC；压缩 span 只借用 subarray，不另复制整批编码页。
- `CookedAssetProtocol/workers`：协议 3，真实 assigned Worker 来源/session/task/epoch/order/transport hash/native extent/representation 校验，原生 bootstrap 不初始化 decoder。每个 span 只取得一次 decoder；模块初始化、解压（含 WASM 输入/输出复制）、实际 fetch/useful/native/cache 各有统计。
- `CookedAssetPreparation/AssetWorkerPool/TiledTextureCache`：`2S+2D` 原子信用，交接后缩为 D，release 转移并 detach 调用者视图，幂等归还；cache 只有 native。构造前从总临时额度预留每配置 Worker `4,314,508 B`，1..4 个；实际 retained 为 0 或 4 MiB，Worker 退出才消账。缓存仍独立上限 128 MiB，ready 64 MiB、encoded 32 MiB，目录另按原 admission。取消/崩溃/重建/注册退休维持唯一所有者。
- `VirtualTextureResidency`、Native shader、FrameProgram/SCGI ABI **无生产修改**。复核 pending 覆盖 ready 批次、一次扣槽容量、现有 copyTile/页表/queue 顺序及 fence；`send1Checked` 会执行所有通知，即使某 observer 抛错，未引入提交后回滚。GPU BC bytes、staging、atlas、pass/dispatch/submit 均不增加。
- 全部直接 oracle/helper 切为 schema 2 或明确 native ready；真实 GPU fixture 由离线 Cooker 固化，运行时经 HTTP/Worker，不再用假的同步 source 代替。冷 BC 参考仅供独立测量/断言，不进入生产 loader。

发布包复核额外修正 `OEngine/vite.config.ts`：库模式会内联 WASM 且绕过普通 assetsInlineLimit；Worker 改 ES 输出，以 Rollup 独立资产 URL 发布同一 hash WASM，避免 data URL 无长度头和重复内联。原 vendor 文件不手改。其余既有 Worker 创建也都是 module 类型。实际构建 Worker 的 HTTP/解压/transfer 已浏览器实跑，不仅检查产物文件存在。

### 7.2 固定来源与构建身份

| 项目 | 实际身份 |
| --- | --- |
| 原始源码 | Basis `99f52d63aa6799cbdaecfe977111dc5ec3b31d47/zstd`，Zstd 1.5.7，BSD 许可；`zstddeclib.c` 原样 |
| 本地构建 | `tools/build-tiled-texture-codec.mjs`，Emscripten 6.0.9；实际命令在仓库根为 `node OEngine/tools/build-tiled-texture-codec.mjs` |
| C 包装 | `OEngine/tools/texture-codec/TiledZstd.c`；`source.json.glueHash` = `26cc375720841a2644604915ae7fea2327b927be6a9b181eec72f9bb1f412f17` |
| WASM | 60,102 B；SHA-256 `298b341aa5bff500b971c4de01ad2a627feabf812fcd6ff7bbb5f2bfe1f1161e` |
| JS | 6,101 B；SHA-256 `c4f45eeebc3cd5d823357312dac85bdd51e0b7f7142813b7597481acce5a2651` |
| 清单/许可 | `OEngine/src/assets/codec/vendor/tiled-zstd/source.json`、`LICENSE`；固定四份 source hashes、compiler、memory、binary hashes |
| 离线压缩 | Node 24.14.0 / Zstd 1.5.7，level 9、checksum/content-size on、无字典/内部并行；只在离线纹理任务中同步逐页调用 |

采用范围是 CPU Zstd 解压内核，不是 WGSL 算法。独立 Node Zstd ↔ 固定 WASM、实际新 Worker → BC atlas → Native/query 消费证据齐备；不据此宣称 GPU 算法移植或整 Renderer 提速。

### 7.3 直接验证与原失败归档

| 检查 | 本次结果与范围 |
| --- | --- |
| 编译与发布 | 新鲜 `build:test`、`npm --prefix OEngine run build`（含 typecheck/Vite/声明）通过；`benchmark-tiled-texture.mjs --dist-worker` 对真实发布 Worker、独立 HTTP WASM 和三语义 81 页逐字节通过 |
| CPU 窄集合 | decoder/product/真实 tiled Worker/VT residency/Cooked Worker 共 **27/27**；记录 `.local/vt-zstd-unit2/cpu-tests.log` |
| 恶意帧 | 高熵可膨胀、错 checksum、截断、无 checksum、未知内容长度、错误 native、超窗口、非零 dictionary、拼接、skippable、尾随垃圾拒绝；每次失败后复用上下文仍能正确解压合法帧 |
| 产品与容量 | BC7 sRGB/linear、BC4、NPOT、三地址、原内块/边缘/tail/coverage 保留；拒绝旧 schema、错误 encoding/native/profile/topology。真实 Worker 64 个展开页与低内存配置测试，创建前拒绝放不下模块+最大 resident 单片的预算，65-ID 请求在 IO 前失败 |
| 所有权与取消 | 原生 bootstrap retained=0，fine 后=4 MiB；混合 cache hit/miss、transfer 后 release、重复 release、排队/执行取消、hash/range/version 错误、真实 Worker crash/replacement、目录/session 退休与 admission 竞态全部检查，credit/metadata/retained 回基线；部分页放弃与剩余批次释放由 VT 契约覆盖 |
| 主 Renderer | `streaming-vt` 通过：当前 view 原生 tail→细页，Native/FSR/AO/SSSR、custom alpha/R8、Product mask、设备丢失 epoch 2 后恢复与 release；无 GPU/scoped/page errors |
| 过滤与真实事务 | `streaming-vt-filter` 通过：36 组×56 点，BC4/颜色/normal、clamp/repeat/mirror、nearest/linear、tail/fine 独立冷 BC 对照；非零 atlas layer、实际 command abort/retry 与 fence 后 staging=0；额外真实压缩页 victim/reload 测得 2 次 evictions/1 次 reload，实际 atlas 采样=独立 224/255 |
| query | `scgi-query-vt` 通过：query-only 缺页触发实际压缩细页，mapping 1→2、resident=3；descriptor CPU 0.104855021331 / GPU 0.104855023324，query refinement 与候选 abort 合同保留。未重跑未修改的完整 GI 算法 |
| 离线完整工具 | 原 PNG smoke 新生成/复用/旧收据 upgrade；260×132 真实 fine GLB 同样三次通过，完整 BC Product 未重复重编码；随后全部 Dungeon 25 纹理升级和原字节对照见 §7.4 |

原失败没有追认为通过：

1. decoder 首次编译引用了 decoder-only 链接没有的 `ZSTD_compressBound`；改用上游 1.5.7 同一宏，不增加 encoder 到浏览器 WASM。
2. 离线 Node async API 产生未知内容长度，严格 decoder 报 -2。修 producer 为一次性同步压缩，保持安全检查；不是放宽帧合同。
3. `.local/vt-zstd-unit2/streaming-vt-filter.json` 及 `-retry.json` 保留首次失败。原 isolated oracle 只注入一次需求，随后的空反馈在真实 HTTP 完成前撤销需求；延长等待不能解决。修为每帧显式完整需求，保留所有数值容差，最终报告 `streaming-vt-filter-final.json` 含真实 layer/abort/victim 检查。
4. 第一次库 build 虽编译通过，但产物检查发现 data URL 和 strict HTTP 不兼容。修专门 Worker asset plugin 与 ES 输出，再实跑发布 Worker；不接受“tsc成功=发布可用”。
5. 新成本宿主初次缺 gl-matrix Worker URL 重写，随后 reference Blob Worker 相对 URL 无 base，均是诊断宿主错误，修为受限静态映射/绝对 URL；未改 production。早期每响应节流结果仅保留 `transport-cost-per-response-not-aggregate.json`，不能当总带宽测量；最终使用共享聚合节流。

静态 GPU 宿主对 pack Range 返回 200，生产立即取消 body，再读有界 shard，因此报告里的 `net::ERR_ABORTED` 是预期 pack 取消；不是 payload hash/解压失败。favicon 403 与 Windows powerPreference 提示也不算本模块 GPU 错误。成功 receipt 的 fetch/hash 指标不含失败下载、HTTP headers、取消前浏览器 socket 预读，不能冒充线速总流量。

### 7.4 真实资产、磁盘与闭包成本

**完整 Dungeon 升级：**只读允许的 `examples/assets/three/rendering-lab/dungeon_warkarma.glb` 与既有认证 BC Products，向新的 `.local/vt-zstd-unit2/dungeon-cooked` 输出，未改原资产目录。25 个旧收据通过原生最终 Product 重建新 tiled，墙时约 38.93 s；收据 `totalEncodeMs` 是复用的历史 BC 编码时间，不当作本次实际编码成本。

全部 8,550 个新 payload 经独立 Node 解压后，与旧认证页逐字节相同：细页 8,525 个，176,774,400→69,376,478 B（减 60.75%）；25 个原生 tail 共 518,400 B。完整输出 pack 69,894,878 B，目录 2,321,342 B；内容寻址 shard 8,156 个/66,247,644 B（允许相同内容复用文件），完整 TextureProduct 包仍 140,025,000 B，三种磁盘复制分列，不能把它们相加说成纯运行时下载。`dungeon-full-byte-oracle.json` 按**新目录文件名排序**拼接的 native/encoded 摘要为 `f78bd7a2718b67011ac3c86639fad0aa63fb467f6fc517b52d789b13faa708d0` / `74d2fe04c83b2fdd2083d40f2202c7590dc290f0eb47ad47378fea68e1303648`；旧调查排序不同，摘要不同不是字节不同。

**可复跑成本入口：**`node OEngine/tools/benchmark-tiled-texture.mjs`；`--dist-worker` 检查发布 Worker；`--dungeon` 读取上述升级产物前三个排序目录、每个最多 64 页，独立原生参考由 Node 解压，不装回旧生产 loader。浏览器版本 Chrome 155.0.8059.82；真实 GPU oracle adapter 为 NVIDIA Turing，未提供型号、温度与功耗锁定，不能充当正式同条件资格。

固定三语义 fixture 每次 trace 各 27 fine 页：BC4 279,936→3,139 B、sRGB 559,872→181,978 B、normal 559,872→219,819 B；合计 1,399,680→404,936 B。三地址含重复内区块，样本为合成高梯度而非真实全场景压缩分布。每个带宽条件 17 个新 Worker trace；首个 scalar 冷实例 17 个样本，随后 color/normal 热实例 34 个，cache 51 个。`cold` 含首次 decoder HTTP/实例化，可能复用浏览器 WASM 编译缓存；不是每次冷 OS/浏览器进程。模块/目录是 loopback HTTP，只有 payload 做共享聚合带宽节流，未模拟 RTT/丢包。

| 条件/准备墙时 ms | 新 Zstd P50/P95 | 独立原生参考 P50/P95 |
| --- | --- | --- |
| loopback 首次 scalar | 15.5 / 21.7 | 4.2 / 7.3 |
| loopback 后续 color/normal | 6.5 / 8.0 | 5.9 / 8.2 |
| 聚合 1,250,000 B/s 首次 scalar | 17.3 / 33.9 | 278.5 / 292.1 |
| 聚合 1,250,000 B/s 后续 color/normal | 205.1 / 231.7 | 563.5 / 570.0 |
| cache（两个条件各51样本） | 约 0.1 / 0.2，无 IO/解压 | 不另建生产编码缓存 |

参考 Worker 使用相同最终 BC 和顺序、逐页 SHA/copy/transfer，但它不实现旧目录/注册/信用；不是旧 renderer A/B 性能基线，不能从差值推导单独解压税。新路径墙时已包含排队、HTTP、hash、解压/复制与交接。最后一次 loopback trace 的解压（含输入/输出复制）合计约 7.5 ms、decoder 获取/初始化约 7.7 ms；hash、WASM copy、编译与队列没有独立精确分解，`busyMs` 含组合成本，不能拿这些相加当 wall。

内存该 trace：实际 Worker 线性内存 4,194,304 B，模块预算 4,314,508 B；任务信用峰值 total 1,559,382 / encoded 219,819 / ready 559,872 B；cache 峰值 1,399,680 B，目录 admission 192,380 B。所有任务 release 后信用0，静止无需求不产生新 fetch/decode，dispose 后 retained/cache/credit归0。浏览器编译代码、JS对象、网络内部缓冲、GC回收延迟未知，不声称总 RSS=这些账户相加；四 Worker/scene 替换仍由总预算而非每 scene 独立扩张。

真实 ORM 请求补测 `dungeon-transport-cost.json`：新目录排序前三项各取64页，共192页，3,981,312→824,416 B，实际成功 HTTP 与有效压缩字节一致、过取0。每条件3条trace，只作粗成本不是统计资格；loopback 冷 P50/P95 21.9/22.4 ms（原生参考13.2/14.4），热9.9/12.2（11.0/12.2）；聚合1.25 MB/s冷106.9/117.3（1274.6/1281.0），热318.2/440.0（1278.4/1291.8）。64页请求连续解压，credit峰值 total3,532,462 / encoded439,127 / ready1,327,104 B，cache峰值3,981,312 B；释放、idle与dispose断言通过。sample所属三份完整目录identity为 `10cedd51f46ef452561d558532339095f280ff2287abe1e4a174d0052c6ea4d5`、`1479c6a18ee93a645d84e5f83fdf0b62b3000abaaa3555ca2b09f18b04daa721`、`18ba8e10f9f5937d6cdf736a6304a49587ffeca100f2f77495800604a6170d35`。

收益裁决：保留此固定无损方案。理想节省 `rN/B`，0% 压缩收益时仅增加成本；50% 时节省 `0.5N/B`，100% 是数学上限 `N/B`。完整 ORM 样本 r≈0.6075，在 1.25 MB/s 时理想减少约85.9 s的串行有效传输，不是实测整场景加载时间。真实高速冷读有明确初始化税，loopback 热读无可靠净提速，受限带宽有显著准备收益；不增 raw fine fallback/动态 selector，不以预算有界或样本减字节宣称 GPU/FPS 提速。

### 7.5 停止边界与未运行项

本模块实现、恶意/字节/容量/生命周期、新生产 GPU/query接线和必要闭包成本检查完成。没有修改 shader、页调度或画质范围，无待修的已知本模块产品错误。来源与 domain 只记实际接线；旧原生细页生产读取已退休。

未运行：完整 Bistro 重 cook（本机原始路径不可用，也不读取排除的大资产）；新格式完整 Dungeon 的 Renderer 镜头轨迹/1080p组合画面与长窗口峰值；跨设备、真实公网 RTT/丢包、正式全 Renderer P50/P95/evidence/claims。它们归最终集成阶段，不把现有旧资产场景历史通过当成新格式通过。此次真实资产 provider 采样不等于全场景画面资格。当前示例若指向原 schema 1 目录会明确要求 recook，**不会自动转到完整 Product 或旧细页**；用户需采用离线新输出。本模块未改写原示例本地资产清单。

文档与工作流保持一对 authority，SCGI 原结果/失败不改。停止在此模块边界，不启动其它效果、不自动提交或推送。

最终文档检查：`node tools/docs-verify.mjs` 为 **0 finding、71 historical warning**；限定新增/改动脚本与关键源码 Prettier 检查和 `git diff --check` 通过。历史 warnings 未改写为本模块错误或修复。实际本地输出保留在 `.local/vt-zstd-unit1/`、`.local/vt-zstd-unit2/`，未登记正式 claims/evidence。
