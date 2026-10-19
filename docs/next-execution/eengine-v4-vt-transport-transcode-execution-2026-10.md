---
id: eengine-v4-vt-transport-transcode-execution-2026-10
state: current
verifies:
  files:
    - docs/next-design/eengine-v4-vt-transport-transcode-2026-10.md
    - docs/porting/next-renderer.md
    - OEngine/src/assets/TiledTextureProduct.ts
    - OEngine/src/assets/TiledTextureSource.ts
    - OEngine/src/assets/codec/TiledTextureCook.ts
    - OEngine/src/assets/codec/TiledTextureTransport.ts
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

唯一详细目标为[设计文档](../next-design/eengine-v4-vt-transport-transcode-2026-10.md)。本版已明确选择 **BC 细页逐页 Zstd → 现有 Worker 解压 → 原有 VT 上传事务**，不再安排泛泛的候选技术研究，也不实施图片解码和 GPU 重编码。

当前状态：**设计已重写；仅完成独立 ORM 页字节调查；产品重构和浏览器/GPU 验证尚未启动。** 工作流当前仍为 Surface Cache GI。本文回应用户的详细设计要求，不擅自切换工作流或开始生产代码修改。

## 1. 工程量与执行组织

这不是重写 VT，也不是新增一个 GPU 算法模块。主要工作量在分块产品、离线复用、Worker 回执和 CPU 信用/缓存；shader、页表和 Native 采样原则上不改。

按真实工程闭包分成两项：

| 工作项 | 内容 | 稳定边界 | 当前状态 |
| --- | --- | --- | --- |
| 一、完成单路径产品重构 | 轻量解压器、schema 2、Cooker、离线工具、Worker 协议、信用、缓存和全部直接读者连续修改 | 新产品从生成到现有 GPU 消费完全连通，旧 schema 生产支持已删除 | 未开始 |
| 二、集中验证与修正收口 | 独立无损/恶意输入、真实 Worker/缓存/生命周期、生产 VT/SCGI 接线和必要成本 | 实际错误修复，直接相关验证与成本结论留存，模块关闭或有据否决 | 未开始 |

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

## 6. 本次设计修订实际完成情况（2026-10-20）

- 已重新核读产品、Cooker、离线复用、真实 Worker、信用/缓存、VT 主/query 调度、原生 bootstrap 和帧命令提交相关实现。
- 已核读固定 Spark JS 与 BC7/BC4 WGSL 的实际输入、stride、dispatch、submit 和许可边界；没有复制其 shader 或声称采用。
- 已核读固定 Basis checkout 中 Zstd 1.5.7 的头文件、帧检查、静态上下文与多帧/单次解压路径；选定轻量独立 WASM 的目标接法，尚未生成新二进制。
- 已对 25 个现有目录的 8,525 个 ORM BC7 细页完成独立 hash/压缩/逐字节往返；最终开启帧校验和后由 176,774,400 B 变为 69,376,478 B，约减少 60.75%。样本不覆盖颜色/normal/BC4；不是浏览器延迟或生产性能证据。
- 本轮未修改任何生产 TypeScript/WGSL/构建脚本，未运行生产 build、浏览器或 GPU 验证。上面两项实施工作均未开始，不能记为实现通过。
- 文档检查：`node tools/docs-verify.mjs` 为 0 项问题、71 项历史警告；已检查两份文档的正文语言及行尾空白，`git diff --check` 通过。历史警告不是本模块运行时验证，也未为此改动无关历史文档。
