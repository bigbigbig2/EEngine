# ADR-0008 · Runtime Asset Package Kernel v1

Status: accepted

## 背景

R2 需要把 Loader/程序化几何转换为设备无关、可重复构建、可在 GPU 分配前完整验证的 bytes。旧 `MeshletGeometryBase`/`niMeshlets` 格式混合 runtime 对象、Meshlet 地址和 GPU owner，没有通用 version/hash/section compatibility，也无法安全拒绝截断、重叠或恶意长度。

Package Kernel 必须独立于 Geometry section 内容：R2-A 冻结容器和验证，R2-B 再增加 GeometryDirectory、Meshlet、Cluster 和 BVH8 sections。浏览器和 Node Cooker 都必须使用同一格式，不能分别维护同步/异步或离线/runtime 两套 ABI。

## 决策

1. v1 固定 little-endian、96-byte header 和 48-byte section directory entry；schema descriptor 为 `OEngine.RuntimeAssetPackage:v1;header=96;directory=48;little-endian;sha256;`，其 SHA-256 低 32 bits 为 schema hash `0x76f894fa`。
2. Header 保存 magic、format version、schema hash、endianness marker、flags、section count/directory、`u64` total byte length 和 256-bit content hash。文件可用 `u64`；JS runtime 必须在转换成 number 前拒绝超过 safe integer 的值。
3. Directory entry 保存 type/required flag、`u64` offset/length、element stride/count、alignment、compression 和 section checksum。v1 section type 唯一且升序；offset 由 directory end 按 section alignment 唯一计算，padding 必须为零。
4. v1 alignment 至少 4 bytes 且是 2 的幂；compression kernel 只接受 `none`。实验压缩必须由新 section/schema/version 引入，不能让 Reader 猜测。
5. 每个 section 计算完整 SHA-256；directory checksum 保存 digest 的低 32 bits用于快速/固定字段验证。Package content hash 是 canonical header identity、section metadata 和每个完整 section digest 的 SHA-256，不依赖 padding或自身 hash field。
6. `writeRuntimeAssetPackage()` 按 type 排序、复制输入 section 并产生 byte-identical bytes。`openRuntimeAssetPackage()`/`validateRuntimeAssetPackage()` 使用 Web Crypto SHA-256，因此是异步 seam；没有 Node-only `crypto` runtime dependency。
7. 未知 required section 必须拒绝；未知 optional section产生 warning并保留只读 view，具体 consumer 可以跳过。Magic/version/schema/hash/range/stride/count/alignment/checksum 失败均发生在 GPU residency 前。
8. Opened package 保留调用方提供的 `ArrayBuffer`；section view 只读是 API contract。调用方在 package 生命周期内不得修改或复用该 buffer；避免默认全包复制造成 load peak 翻倍。
9. Package Kernel 不解释 Geometry/Material/Texture，也不创建 GPU 资源。Geometry cross-section validation由 R2-B 的 `GeometryAssetValidator` 拥有，GPU `u32` range/capacity 由 R2-C 再验证。

## 后果

- Reader/Writer/Validator 是同一深 module，格式错误不会延迟到 Shader 或 Buffer upload。
- Web Crypto 使 open/write 异步，但资产加载本来就是异步边界，并避免新增 SHA 实现/依赖。
- section checksum 只有 32-bit 快速字段，安全身份仍由完整 content SHA-256 提供；不能单独把 checksum 当抗碰撞身份。
- v1 不支持 inplace package mutation。修改 section 必须重新 write/package/hash。
- Geometry sections 尚未存在时，Kernel 只能证明容器正确，不能宣称 R2-B Cooker 或 G2 完成。

## 验证

- 同一输入两次 write 的 bytes 相同，并保存 whole-file/content-hash 黄金值。
- 测试 magic/version/schema/endianness、required/optional、截断、checksum、content hash、非 canonical offset、alignment、reserved field 和超过 JS safe integer 的 `u64`。
- tiny triangle、Box、multi-material、alpha-tested 和 degenerate SourceGeometry 通过相同输入 seam；invalid index、NaN/Inf 和 material coverage gap 在 Cook 前拒绝。
- `npm run build`、定向 package/source tests 与完整 `npm test` 必须通过。
