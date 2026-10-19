---
id: eengine-v4-vt-transport-transcode-2026-10
state: current
verifies:
  files:
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
    - OEngine/src/gpu/VirtualTextureAbi.ts
    - OEngine/src/gpu/VirtualTextureResidency.ts
    - OEngine/src/gpu/TextureResidency.ts
    - OEngine/src/framegraph/ShadeGPUCommandContext.ts
    - OEngine/src/render/program/FrameProgramLowering.ts
    - docs/next-execution/eengine-v4-texture-compression-execution-2026-10.md
    - docs/next-execution/eengine-streaming-vt-execution-2026-10.md
    - docs/porting/next-renderer.md
    - project/workstreams/active/eengine-next-clean-rebuild.yaml
---

# VT 细页无损传输压缩设计

本文全面替换前版含大量英文、选型未完成的设计。文件名保留便于既有链接定位，但**主方案不再是图片解码后 GPU 重编码，而是最终 BC 块的逐页 Zstd 无损压缩**。对应[执行文档](../next-execution/eengine-v4-vt-transport-transcode-execution-2026-10.md)。

这是依据当前代码给出的目标设计，不是已完成实现。2026-10-20 核对基线为 `a2b3f8e3739055fb28e335c02e41b0cf91ded5f8`；本轮只改文档并做独立资产字节检查。当前活动模块仍是工作流中的 Surface Cache GI，不擅自修改其 authority 或宣称本模块已启动。

## 1. 重新审评后的结论

附件把“传输格式”和“显存格式”分开，这个问题判断正确；保留已有 VT、原生尾页和精确覆盖的方向也正确。**但这不推出必须增加 GPU 编码器。** 用户追求极致执行效率、干净的单路径和大胆重构，应先消除不必要的工作，而不是为了采用 Spark 增加一套冷路径 GPU 作业。

本次确定采用：

```text
现有语义 mip / BC 编码 / 地址边框生成
  → 最终 144×144 BC 细页
  → 离线逐页 Zstd 压缩、hash、pack/shard
  → 现有延迟反馈与需求准入
  → 现有 Worker 拉取、校验、受限解压
  → 完全相同的 BC 页租约
  → 现有帧命令上传、槽位替换、页表发布
  → 现有 Native / VSM / SCGI 消费
```

具体决策：

| 对象 | 确定方案 | 原因 |
| --- | --- | --- |
| 虚拟细页 | 每个完整物理 BC 页对应一个独立 Zstd 帧 | 随机读取不变；不依赖邻页、字典或整图 |
| 编码配置 | Zstd 1.5.7，级别 9，内容长度和校验和开启，无字典、无多线程 | 已有实际页试算；离线承担压缩成本，运行时只解压 |
| GPU 格式 | 现有 BC7 sRGB、BC7 linear、BC4 不变 | 不重新编码、不改变质量和采样 ABI |
| 尾页、常驻平面、精确覆盖 | 保持现有原生 BC/R8 | 启动不等待新解压器；常驻由实际材质依赖决定，不仅是 coverage |
| 运行时解压 | 现有 Cooked Worker 池内的独立轻量 Zstd WASM | 不加载整个 Basis 编码器或 libktx，不新增调度器 |
| CPU 缓存 | 缓存解压后的原生 BC，保持现有独占 take/release 模式 | 再次请求不重复网络读取和解压，不保留双份缓存 |
| 产品切换 | 分块产品 schema 2，旧 schema 1 明确要求重 cook | 无永久兼容桥、无运行时新旧选择器 |
| GPU 编码 | 本模块不接入 Spark，不增加编码管线和临时 RGBA 图集 | 有损质量、资源和帧内争用都不是解决传输体积的必要成本 |

“单路径”指唯一生产所有权和固定的产品语义，不是强迫所有资源使用一种字节编码。原生启动数据与 Zstd 细页是 schema 2 内按用途唯一确定的表示，不是两套可互相回退的生产实现。细页始终使用 Zstd，即使个别高熵页略微变大，也不另留原生细页分支。

## 2. 为什么前版方案不够合理

1. **把附件中的技术路线当成了答案。** 前版虽然提出很多风险，却把 codec、解码器、编码器和批处理方式留给实施者再选，不能算可执行的详细设计。
2. **忽略现有 BC 块保真优势。** `TiledTextureCook.#region` 会直接复制完整原始块，只对必要边缘条带重编码；repeat 完整周期块也直接复用。图片传输后再编码不仅多做工作，还抛弃原有编码质量和字节一致性。
3. **漏掉独立有损页的接缝风险。** 相同源边框分别经过有损 AVIF/WebP 后，不保证重建值相同。离线先生成 gutter 不等于解决了有损页边界；再加不同 BC 编码器与原生尾页，必须重新证明跨页与跨 mip 质量。
4. **没有算实际上传放大。** BC7 原生页只有 20,736 B；RGBA 输入却有 82,944 B，再有对齐 staging、GPU 输入与 BC 输出。减少下载字节不能自动证明端到端执行更快。
5. **错误地偏好提前锁物理槽。** 长网络等待期间占住可驱逐槽会损害有效工作集。现有实现的“可回收容量背压，编码命令时才选择实际槽位”更适合保留；必须完整计入待处理及就绪租约，而非加一套永久预约表。
6. **对 Spark 接口过于抽象。** 其公开入口自建 encoder、自行 submit，输出复制默认 layer 0；现有 WGSL 是 `texture_2d`，不能凭空声称按格式合并后一次 dispatch 就能处理任意页数组。

前版英文正文和这些设计缺口均在本版纠正，不把“尚需测量”写成“未完成选型”的借口，也不把真实风险伪装成已验证结论。

## 3. 当前源码：真正需要改动的边界

| 文件/所有者 | 当前实现事实 | 本模块处理 |
| --- | --- | --- |
| `assets/TiledTextureProduct.ts` | schema 1；128 内区、8 边框、144 物理尺寸；虚拟 payload 长度必须等于 BC 页长；完整 mip、尾页、常驻与引用闭包校验 | 升 schema 2；拆分磁盘长度与原生长度；保留全部拓扑校验 |
| `assets/codec/TiledTextureCook.ts` | `appendMip` 同时收到 canonical RGBA 和已经编码的 BC；`#region` 复用内区块；尾页打包后共享一个 payload | 只在最终细页 BC 产出后增加压缩；不碰 mip、normal、gutter 和 BC 编码算法 |
| `tools/cook-offline-scene.mjs` | 保存完整 TextureProduct、分块目录、pack、内容寻址 shard；复用检查目前主要看地址模式和 residentRoles | 更新配置身份、复用判定、两种长度验证与收据；不让旧分块产品被误认为新产物 |
| `assets/codec/TiledTextureTransport.ts` | 最多 64 个 ID；合并范围 ≤1 MiB、≤有效字节两倍、间隙 ≤64 KiB；要求 identity HTTP body；每页 hash | 范围始终按压缩长度；校验后在 Worker 解压；返回原生 BC |
| `assets/codec/CookedAssetPreparation.ts` | 现用相同 payload 长度计算输入/ready 信用、校验回执、缓存命中；release 会转移并使旧视图失效 | 这是主要重构点：输入按传输长度，就绪与缓存按原生长度；不能仅改读取 helper |
| `assets/codec/AssetWorkerPool.ts` | 同一池服务几何和纹理；取消活跃任务会终止 Worker；替代 Worker 重新注册 | 保留该机制；新 WASM 的常驻内存和初始化必须纳入账户 |
| `assets/TiledTextureSource.ts` | 可重开的设备无关目录和读页入口，不持 GPU 或页回放 | 对 GPU 继续返回原生 BC 租约，不暴露压缩算法 |
| `gpu/VirtualTextureResidency.ts` | 需求、主视图与 query 公平性、粗层依赖、最多 4 批且每批 32 页、就绪租约、槽位/generation、上传和发布 | 算法与返回数据形状不变；核对字节指标和全部租约背压 |
| `gpu/TextureResidency.ts` | 基于 coverage 与实际图依赖闭包决定强制常驻；bootstrap 读取原生 resident/tail | 保持原生表示，不能只保留 R8 而误把其它 coverage 依赖虚拟化 |
| `render/program/FrameProgramLowering.ts` | 现有上传节点写页表与各 BC atlas，再被 Native/SCGI 使用 | 不加新 pass、scratch 或隐藏 GPU 资源 |
| `framegraph/ShadeGPUCommandContext.ts` | 提交、提交后通知和 GPU 完成 fence 是不同阶段 | 本模块沿用，不能把 `onFinished` 当成 GPU 完成 |

当前 VT 已经实现并接入生产，不依据较早 Texture 文档中的“VT 未实施”描述重造一套 VT。现有 SCGI query-only 需求、主视图/query 分配及 mapping generation 失效规则都是存活语义，不能因传输改造丢失。

## 4. 实际资产检查与证据边界

2026-10-20 读取本仓库 `.local/models/scgi10-dungeon-cooked/textures` 的全部 25 个现有目录；先验证目录及每个 payload 的 SHA-256，再对每个细页独立压缩并解压逐字节比较。

| 项目 | 结果 |
| --- | --- |
| 样本语义 | 全部是 `orm-linear` / `bc7-rgba-unorm`，不是全语义场景资格 |
| 细页数量 | 8,525 |
| 原生细页总长 | 176,774,400 B |
| Zstd 细页总长 | 69,376,478 B |
| 减少字节 | 107,397,922 B，约 60.75% |
| 膨胀细页 | 0；单页最大压缩长度 16,472 B |
| 原生尾页 | 25 个，共 518,400 B；目标方案保持不压缩 |
| 无损检查 | 全部样本逐字节往返相等 |

试算环境为 Node `24.14.0` 内置 Zstd `1.5.7`；初次未开帧校验和试算为 69,342,378 B，最终采用上表开启校验和的配置，不能混用两组结果。详细本地记录为 `.local/document-review/vt-lossless-page-audit.json`，它是本机调查输出，不是已提交的正式性能证据。

目录文件名排序后以换行拼接的 SHA-256 为 `9faa721ee87217de2635f2cacb15ed87127bf164bfa200114e8568c5e015eed0`；按该顺序及目录 payload 顺序拼接细页，原生字节摘要为 `b16f55292779dbf925434ce0d96140d80e5346512a441688bb4c44f92782d62d`，压缩字节摘要为 `c176df39f7d80728369a608940766f70f11f5bd279c213a488090c00e1a7b696`。

**已经说明的只有：本地这组真实 ORM 页具有明显无损压缩空间，且独立帧可以精确还原。** 未测浏览器 WASM、冷初始化、真实请求顺序与过取、颜色/normal/BC4 分布、页面就绪延迟或帧率。不能把 60.75% 推广为全场景网络降幅，更不能说已经提速。无需重新读取用户排除的旧大资产来完成这项模块检查。

## 5. 产品合同：长度、身份和路由

### 5.1 固定 schema 2，不造通用格式注册系统

保留目录原有 `source`、`sourceIdentity`、plane/mip/page ID、地址模式、尾页位置、pack/shard 关系。源 TextureProduct 仍是 schema 3，其语义和最终 BC recipe 不变。分块 recipe 升为版本 2，增加一份目录级固定传输配置：

```ts
transport: {
  codec: "zstd-bc-v1";
  encoderVersion: "1.5.7";
  level: 9;
  checksum: true;
  contentSize: true;
  dictionary: false;
}
```

本段为目标字段形状，不表示接口已经存在。编码器二进制/构建身份写入 cook 收据与传输 recipe 身份；最终目录本身仍由精确字节 SHA-256 认证。离线生产固定 Node/Zstd 版本或同版本固定原生构建，不能假定不同版本压缩字节天然相同。

每个 payload 继续保留 `id/offset/byteLength/hash/shard`，增加：

```ts
encoding: "gpu-native" | "zstd-bc";
nativeByteLength: number;
```

含义必须唯一：

- `byteLength`、`offset`、`hash`、pack/shard 内容全都属于**传输字节**，压缩细页的 hash 不是解压 BC 的 hash。
- `nativeByteLength` 是交付直接消费者的精确原生字节长度，既不是 RGBA 大小，也不是 256 B 行对齐后的上传大小。
- 虚拟且 `level < tailFirst` 的页只允许 `zstd-bc`；虚拟尾页及全部 resident 片段只允许 `gpu-native`。同一个 payload 被不同用途引用时必须拒绝，尾页合法多 mip 共享除外。
- BC7 细页原生长度固定 20,736 B；BC4 固定 10,368 B。GPU 格式直接从 `sourcePlane` 推导，禁止冗余、可矛盾的逐页任意格式字段。
- 原生 payload 的 `nativeByteLength === byteLength`；resident mip 的片段**原生长度之和**等于源 mip 长度。现有 1 MiB resident 片段上限不变。
- 压缩细页长度必须在 `1..ZSTD_compressBound(nativeByteLength)`；1.5.7 下 BC7 上界 20,870 B、BC4 上界 10,466 B。常量由固定 ABI/helper 唯一提供并与上游函数核对，不散落复制魔数。

完整保留：严格键集合、整数/溢出、连续 pack 偏移、完整网格和 mip 链、source 格式/recipe、tail origin、coverage 常驻、全部引用与无孤儿校验。改变的是细页传输长度规则，不是放松目录验证。未知 schema/profile 明确报需重 cook，不尝试嗅探字节或恢复旧版本。

### 5.2 完整性与解压安全

处理顺序固定为：验证已认证记录 → 受限 HTTP body → 压缩字节 SHA-256 → 帧头/域检查 → 固定容量解压 → 精确原生长度 → 交付。

固定 C/WASM 包装层检查：普通 Zstd 帧、已知内容长度恰好等于 `nativeByteLength`、窗口 ≤原生页大小、无字典、校验和开启、`ZSTD_findFrameCompressedSize` 恰好覆盖整个 payload。拒绝拼接帧、skippable 帧、尾随垃圾、未知内容长度与截断。不能只用 `ZSTD_decompress`：其内部多帧循环允许拼接/跳过帧，比本产品合同宽。

使用受信目录推导的输出容量调用 `ZSTD_decompressDCtx`，绝不按不可信帧头申请任意内存；返回值必须精确匹配并检查 `ZSTD_isError`。SHA-256 认证传输内容，Zstd 校验和验证解压结果；不在每次读取额外计算第二遍原生 SHA-256。原生字节摘要用于离线/独立 oracle，避免为验证机制增加常规热路径税。

HTTP 仍要求 `Content-Encoding: identity`；应用层 Zstd 已在包内，不是让 CDN gzip/Brotli 整个 pack。Range 不支持时沿用现有“取消 200 大包 body，改取有界 shard”的传输策略，这是同产品的 IO 策略，不是旧纹理实现回退。

## 6. 离线生成：复用已有高质量 BC，而不是重新编码

`TiledTextureCook` 在生成 fine `#region` 的最终 BC 字节后调用一个固定压缩入口；原生 tail/resident 继续原样交给 sink。`appendMip` 对借用输入的现有 await 合同不变：输入只能在回调返回前使用，异步压缩必须完成或先取得独占副本，不能把借用视图存给后台任务。

- 不重新采样整图，不从有损 BC 解码为图片，不重复生成 normal mip，不在运行时生成 gutter。
- 保持现有完整源块复用、边界条带重编码、NPOT 和 clamp/repeat/mirror 规则，因此每个页解压后与原有最终 BC 字节严格相同。
- 逐页压缩、立即 hash/写 pack 和 shard；只保留当前页和压缩 scratch，不积累全场景页数组。
- 目录中的偏移和 pack 摘要按压缩后字节计算；原生页总量另作统计，不能覆盖“传输 payloadBytes”。
- 分块复用检查必须包含 schema/recipe/传输配置和编码器身份。旧目录与旧收据配置不匹配时只失效分块产物；已有完整高质量 TextureProduct 仍可作为离线输入复用，不必重做昂贵 BC 编码。
- 当前工具会同时保留完整 TextureProduct 与分块包。这是离线缓存/不同产品用途，不要求运行时下载两份。分块部署按材质 manifest 的 tiled 入口选择目录/pack 或 shard；报告磁盘体积时将完整产品、pack、重复 shard 分开，不伪称全部磁盘字节都减少。
- 旧 schema 的明确重 cook 错误由离线工具识别后重新生成，不用宽泛 catch 掩盖 hash 损坏、权限或 IO 错误。保持 `.partial` 完成后原子发布和内容寻址规则。

## 7. Worker、租约和缓存：真正的重构重点

### 7.1 只扩展现有所有者

`CookedAssetPreparation` 继续负责 CPU 信用、Worker 任务、session、目录注册、取消和租约；`TiledTextureSource` 只转发；`VirtualTextureResidency` 继续独占 GPU 页与槽。不得新增 `TextureTranscoderManager`、解码池、纹理资源系统或通用 codec 注册表。

`CookedAssetProtocol` 升为版本 3，所有主线程/Worker/测试直接同时切换。其它任务保持原有含义，只改统一版本；旧协议不兼容，不加双版本处理。`tiled-payload` 任务携带已认证的 encoding 和两种长度；回执明确标识 `representation: "gpu-native"`，其 `bytes` 必须是精确、独占、可转移的 BC/R8 存储。回执中的 payload hash 仍指传输身份，不能宣称已对 BC 算过同一个 hash。

继续验证实际分配 Worker 回执的来源品牌、session/task/epoch、目录 registrationKey、ID 顺序与完整域；新增原生长度/表示校验。不能把普通对象或主线程伪造结果当作 Worker 成功回执。

### 7.2 固定轻量解压器

从当前已固定 Basis checkout 中的 Zstd 1.5.7 `zstddeclib.c` 构建独立 WASM；不把整个 `basis_bc.wasm` 或 `ktx_pc.wasm` 引入细页运行时。后两者的当前配置不能被当成现成 Zstd 页 API，Basis 构建甚至显式关闭了 KTX2 Zstd 支持。

目标文件局部放在 `assets/codec/` 与 `vendor/`，构建入口沿用当前固定源码、hash 和 license 清单机制；C 包装只暴露初始化与受限页解压。每个实际 Worker 最多一个惰性实例，用静态 DCtx 工作区复用，不逐页分配上下文；使用固定 4 MiB WASM 线性内存、禁 memory growth。栈、上下文、最大输入和输出均包含在该上界中，构建/测试必须验证能容纳；不足就显式调整预算和设计，不能偷偷增长。

模块只有处理首个 `zstd-bc` 时初始化；原生 bootstrap 与普通固定 BC 产品不触发它。初始化失败明确返回失败，走现有任务错误/重试规则，不转用主线程、浏览器图片解码或另一实现。Worker 被取消终止时实例随之释放，替代 Worker 重新注册、初始化，不能让迟到结果复活旧 session。

### 7.3 解压后的租约和缓存

网络 miss：Worker 在已预留输出信用内读取压缩范围，逐页 hash/解压，拷出精确原生 ArrayBuffer 后 transfer；尽量用范围 subarray 校验和输入，不再为每个压缩细页额外保留一份编码 slice。WASM 输入/输出区可以逐页复用，因为返回的 BC 已有独占存储。

缓存 hit：`TiledTextureCache.take(directoryIdentity/id)` 得到的始终是已验证原生 BC，不再次解压。缓存键包含目录身份，所以同一 ID 的新产品不会混用旧字节。缓存从当前“碰巧等同磁盘表示的 BC 字节”明确改成“原生 ready 表示”，不是把压缩帧和 BC 混放到同一 Map。

租约 release 继续转移存储并使调用者旧视图失效，再按原生长度进入有界缓存；session/目录取消不入缓存。不能同时保留编码缓存、解压缓存、Page.ready 副本和隐藏 replay。VT 每批持有一个租约，已上传/放弃全部页后释放；一页失败或取消不得泄漏其余页信用。

### 7.4 输入、输出和常驻内存分账

定义 `S` 为实际合并响应总长，`E` 为请求有效传输字节和，`D` 为所有请求的原生长度和，`W` 为一个实际 Worker 解压器常驻上界 4 MiB。

- IO 合并与 encoded 信用按 `S`；ready 信用按 `D`。不能继续用旧 `readyBytes = sum(byteLength)`。
- 首次统一为整次请求预留保守临时额度 `2S + 2D`，encoded=`S`、ready=`D`；它覆盖 body/分片复制和输出/交接峰值，不依赖压缩率。Worker 的 `estimatedPeakBytes` 也必须由新输入/输出域计算，不能保留 `span.byteLength * 4` 的隐含展开比。
- 完成 transfer 后原子收缩为持有 `D`，ready=`D`；release/cancel 才归还。缓存另按原生实际 backing bytes 记账，最大仍为现有 128 MiB，不和 ready 信用重复冒充一份所有权。
- WASM 常驻内存独立预留：构造 preparation 时从既有总临时预算划出 `maxWorkers × W` 的最坏上界，再给瞬态任务剩余额度；至少应能容纳一个最大原生 resident 片段请求的瞬态开销，否则配置创建时拒绝。64-ID 是域上限，不承诺任意 64 个 1 MiB 片段都能装进任意信用配置；超单次信用的请求在读取前明确拒绝，调用者事先按额度拆批，不能先读一部分再截断结果。这里预留的是上界，不是启动全部实例。证据同时报告实际实例数、实际线性内存、预留和峰值。
- WASM 二进制/JS 加载也必须有构建清单大小上界；加载瞬态计入模块初始化账户，编译器/引擎内部不可精确观测部分标为未知，不把 4 MiB 线性内存宣称成整个浏览器占用。
- Worker 内任务使用顺序页解压，输出累计最多 `D`，固定内存区在 `W` 内，不需要整批 RGBA。现有 64-ID、1 MiB 响应、4 范围并发与 1..4 Worker 上界保留；不把并发相乘后遗漏旧新 scene 替换峰值。

实际 cache hit 可不占网络请求信用，但第一版允许按完整请求保守预留 `S` 再缩减，不为了省少量信用制造 take 后等待导致的悬挂所有权。所有错误路径必须统一结算，并保留几何与纹理共享 Worker 池的现有优先级。

## 8. GPU 与提交生命周期：不新增架构税

GPU 收到的仍是完整原生 BC 页，因此 `copyTile` 的合法性不变：36 块行；BC7 有效行 576 B、上传 pitch 768 B，总 staging 27,648 B；BC4 有效行 288 B、pitch 512 B，总 staging 18,432 B。物理复制尺寸仍 `[144,144,1]`，槽位 origin/layer 由现有 16×16 布局计算，页表仍写 slot/generation。

**本模块不新增 GPU buffer、texture、pipeline、bind group、dispatch、pass、readback 或 submit。** 保留当前 `FrameProgramLowering` 的上传节点与资源依赖。不能因为文件名里有 transcode 就强行创建 GPU 产品。

页面流程只在设备无关准备阶段新增解压：

```text
需求已准入 → 有界读取/解压 pending → 原生 BC ready 租约
  → 帧内选定 free/victim 槽 → 记录旧映射失效/BC 写入/新映射
  → 已提交后的 CPU 所有权结算 → GPU fence 后 staging 退休
```

物理容量背压沿用 `pump`；其 `pending` 在 ready 阶段仍指向租约批次，因此当前遍历也覆盖就绪页。实施时验证每份未消费租约只扣一次容量，不错误另扣 ready，也不遗漏已从某集合移出的页。不要提前把网络任务绑定到不可更换的 victim；真正记录上传时重核 source.live、admitted、槽位可回收性与 generation。

- 提交前 abort：没有 GPU 修改生效，归还新选空槽、撤销候选 mapping generation，按原规则保留可重试 ready 或安全释放。
- `onFinished` 是已提交后的通知，不是 GPU 完成；CPU 发布反映同一 queue 中有序写入，临时 GPU staging 继续由 `gpuDone` 保护。
- `queue.submit` 后再有通知异常不能回滚已经发生的 atlas 写入。所有被选页必须完整结算；若现有回调异常路径暴露漏结算，在原 VT 事务内修正，不能恢复旧映射假装提交未发生。
- staging 在失败 fence 上只能销毁/终止所有者，不能当成已完成资源放回可复用池；本模块不引入新池。
- scene/source 退休、延迟 Worker 输出、query 需求撤销和设备恢复沿原对象身份/session/epoch 合同。BC 缓存与 GPU 设备无关，设备丢失不要求重新压缩或清空合法 CPU 缓存；新的 VT owner 只按反馈恢复细页，不一次重建全部细页。
- SCGI 的 `mappingGeneration(command)` 同帧候选、提交修订与 abort 撤销保持，不能只验证主视图而漏 query 材质消费。

## 9. 成本卡与收益条件

### 9.1 已选方案相对当前 BC 传输

| 成本项 | 增加/删除与上界 |
| --- | --- |
| 网络/磁盘读取 | 由固定 BC 页长变成压缩长度；高熵最坏每 BC7 页 +134 B、BC4 +98 B；真实样本显著减少，但不是所有页保证缩小 |
| CPU | 增加帧头检查、Zstd 解压、一次 WASM 输出到独占 BC 的拷贝；传输 hash 原本已有，校验工作按新输入计；缓存 hit 不做解压 |
| CPU 常驻 | 每实际解压 Worker 4 MiB 线性内存上界，最多 4 个；模块加载与引擎开销另列 |
| CPU ready/cache | 仍按原生 BC 长度，不出现 RGBA ready；新原生缓存本质容量与现有相同 |
| GPU ALU/采样/原子/屏障 | 增量全部为 0 |
| GPU dispatch/pipeline/submit | 增量全部为 0 |
| GPU 上传/显存 | BC staging、atlas、页表和物理复制字节不变；传输压缩不等于减少 VRAM |
| 稳定帧 | 无新需求则新读取、解压和 GPU 工作均为 0；缓存也不主动扫页 |

以网络吞吐 `B`、原生有效字节 `N`、传输节省比例 `r` 表示，只考虑同请求结构的粗近似：

```text
理想 IO 节省 = r × N / B
额外准备成本 = 解压 + WASM/输出复制 + 冷初始化分摊 + 新队列等待
成立条件：IO 节省 > 额外准备成本 + 过取/请求结构变化的净代价
```

0% 节省时只有税，50% 时理想节省 `0.5N/B`，100% 只是数学极限 `N/B`，实际有帧头且达不到。必须分别报告冷加载、缓存命中、带宽充足和受限网络；不把 CPU 和网络能够重叠的 wall 简单相加冒充实测。网络很快或输入高熵时可以没有端到端收益，届时根据真实结果整体修订/否决本模块，而不是在产品中增加动态新旧选择器。

### 9.2 为什么本轮不选 GPU 重编码

RGBA 页 82,944 B，经 buffer→texture 256 B 行对齐上传需要 110,592 B；BC7 原生 staging 仅 27,648 B。前者还需 GPU 可采样输入与对齐 BC 输出，不能只算输出 BC 大小。即使使用不同上传方式省掉部分 padding，也消除不了更多输入流量和编码 ALU/争用。颜色解码后 BC 编码属于新增有损处理，现有质量合同不能靠“视觉差不多”放宽。

GPU 图片路线在极慢网络下可能优于 BC+Zstd，**这里不声称数学上永远更慢**；本轮证据支持的是先选无损且零 GPU 增量的较小闭包。如果后续实测表明 BC+Zstd 全场景压缩不足且仍有强需求，再单独重设计图片路线，而不是本模块同时落两套。

## 10. 外部实现核对与被放弃的路线

### 10.1 Zstd：选定的成熟实现

复用已固定的 [Basis checkout](https://github.com/BinomialLLC/basis_universal/tree/99f52d63aa6799cbdaecfe977111dc5ec3b31d47/zstd)，revision `99f52d63aa6799cbdaecfe977111dc5ec3b31d47`，其中 Zstd 版本宏是 1.5.7。核读 `zstd.h`、`zstddeclib.c` 的帧头、帧长、静态上下文与解压入口；采用其 BSD 许可选项，随独立二进制保留 `zstd/LICENSE`。不把 Basis 的其它许可或现有 libktx 二进制身份当作这个新模块身份。

上游输入帧/熵解码/LZ 重建/校验阶段完整保留，只加本地有界单页合同，不重写压缩算法。具体来源与目标映射记录在[已有来源账本](../porting/next-renderer.md#vt-无损传输压缩研究2026-10-20)。当前身份是已研究、目标复用，尚无浏览器生产采用证据。

### 10.2 Spark：核过源码，保留参考但不选入

固定 [Ludicon/spark.js](https://github.com/Ludicon/spark.js/tree/b9ea643a08cb9eef3a9ddc64564089bdd6fd0daf)，revision `b9ea643a08cb9eef3a9ddc64564089bdd6fd0daf`。本次直接核读 `src/spark.js::encodeTexture/#loadPipeline` 与 BC7 RGB/RGBA、BC4 WGSL 的输入、块写入和入口；既有纹理执行记录 §9.3 的大纹理探索不当成 144 页生产证据。

实际物理执行是一个 invocation 编一个 4×4 块，工作组 16×8；144 页有 36×36 块，独立 dispatch 为 3×5 组，含 1,920 个 invocation，实际有效块 1,296。BC7 输出行按 `align(blockWidth,16)×16`，此处为 768 B；BC4 按 `align(blockWidth,32)×8`，此处为 512 B。输出不能任意假设紧密 BC 行。公开 JS 会自己 submit，复制目标默认 layer 0；直接调用违反当前帧事务。

若未来接入，只能剥离外层调度，把输入、输出块、atlas origin/layer 与命令交给现有 owner。最直接的合法批处理是一个 compute pass 内逐页 dispatch；“同格式一次 dispatch”需要进一步布局或 shader 适配及独立证明，不能预先承诺。JS 为 MIT，编码 WGSL 另受 Spark EULA；学习评估与商业分发权限分列，**本次不采用的主要技术原因是额外工作与质量/生命周期闭包，不以许可证阻止研究**。

### 10.3 其它选择的裁决

- AVIF / 有损 WebP：本轮不选。独立页接缝、色彩转换、normal/ORM 非颜色数据及二次 BC 误差尚需完整重验证，不符合无必要质量变化的首选。
- 无损 WebP → GPU BC：可以避免传输有损，但仍增加 RGBA 展开、上传和 BC 重编码，不能优先于已具有实际压缩空间的最终 BC 无损压缩。
- Basis/KTX2 运行时转码：不作为本轮候选矩阵。会改变页编码/质量，且不是把已有 libktx 函数接上就能保持原 BC 字节。
- BC+LZ4：已有几何 LZ4 helper 不能自动复用成纹理协议；Zstd 已有固定成熟实现和本地压缩证据，本轮固定一种算法，避免为了少一项依赖自写新熵解码器。未做配对 LZ4 测试，不声称其必然更差。
- 字典、superpage、跨页 delta、去重与 BC 位重排：均不引入。可能提高压缩率，但增加依赖、过取或还原工作；先交付逐页无损闭包，不预建未来调度器。
- GPU Zstd 解压：不引入。它会新增 GPU 算法、输出布局和计算争用；本轮没有足够证据证明比 Worker 解压更优。
- 通用 raw 浏览器冷编码、普通 TextureProduct 分发压缩：本模块不扩大到这些所有者。它们可另论，不能借此重开已经关闭的 Texture 重构。

## 11. 原子删除边界和完成条件

删除/替换的是 schema 1 分块表示与其固定“传输长度等于 BC 长度”的假设；新 schema 只运行新合同。**不删除最终 BC 页生成、原生 BC 上传、尾页、常驻、TextureProduct 或现有 VT 算法**，它们是新方案直接复用的唯一生产闭包，不是残留旧路线。

开发可暂时断链，完成边界同时切换产品、Cooker、Worker、信用、缓存、全部实际读者与离线复用逻辑，马上迁移/删除只断言旧表示的测试。不会设计新旧并跑、长期 adapter、失败后原生细页 fallback 或每 patch 场景测试。

完成必须有：schema/解压安全与逐字节 oracle；真实 Worker/缓存/取消闭包；原有 Native 与 SCGI 页消费及提交/abort/retry/loss；创建前能力/容量检查；真实代表页与实际请求下的字节/延迟/内存成本。未修改的 shader 数学和过滤算法不反复重证；已发现的接线/容量/所有权错误不能留到最终整合。完整 Renderer 正式 P50/P95 与跨设备资格仍按工作流集中完成，不能用本轮文档或字节试算提前宣称。
