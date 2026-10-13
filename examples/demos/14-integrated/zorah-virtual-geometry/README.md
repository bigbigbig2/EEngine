# Zorah Virtual Geometry Stress Lab

直接加载 `D:\shu\engine\.local\validation\nyx-zorah\cooked` 中的离线几何产品，使用现有 production Renderer、Product admission、共享四 bank 驻留与 Geometry streaming。不在浏览器 Cook，不复制 45.5 GiB 模型进仓库或 build。

在 `examples` 目录运行：

```powershell
yarn demo:zorah
```

打开 `/demos/14-integrated/zorah-virtual-geometry/index.html`。常规 `yarn dev` 也支持相同本地资源路由。这个资源挂载仅用于开发服务器；静态部署需自行提供相同 `/assets/local-zorah/cooked/` 路由与正确的 HTTP Range 支持。

## 模型与范围

最终 manifest 有 2,150 个包、3,163 个 asset、19,144 个实例。Cook 报告的源三角形数为 1,627,207,159，包总量 48,816,885,070 bytes；材质目录无纹理。这些是源/Cook 数字，不是每帧可见三角形或 GPU 渲染工作量。

默认加载 **包 [0, 2150)** 的全部 **19,144 个实例**（`packStart=0&packCount=0`）。面板与 JSON 始终记录真实范围。`packStart` 是最终 manifest 的 pack index，**不等于 meshes 文件夹编号**。重模型预设为包 2096，即 `meshes/02018`，单个源 mesh 约 32,054,609 三角形。`packCount=0` 表示从起点到末尾；“全量尝试”设置起点 0、数量 0。已有 URL 的显式部分范围仍按该范围加载。

示例保留所选包的所有原始实例、变换、材质和显式 flags；CPU 场景映射先通过身份/hash/工作容量检查，再上传 bootstrap，最后原子发布所选范围。Cook 中每 mesh 的 scratch manifest 含旧实例语义，不能作为当前合同。Loader 使用从已验证最终 manifest 投影出的包级目录，保留原始显式语义。

全量全细节理论上界为 444,363,334 条 MeshletWork；这是场景统计，不是本帧可见队列长度。CPU 保留完整统计与所有实例，GPU 按既有 frustum、LOD、residency 和 meshlet 选择生成紧凑的帧队列。VisibilityKey 继续指向这个帧队列，24 位身份格式不变。默认物理队列 4,194,304 槽，可用 `workMi` 提高到 16,777,216 槽。

实际 GPU 队列溢出时拒绝整个 cut，间接 draw/count 归零，错误保持 sticky，直到冷重建 workset；不绘制部分队列，不截断或绕回身份。Streaming owner 对已完成帧的 32 B header 做独立必要反馈，main/shadow 分开，采集关闭也能报告失败；它不参与本帧 GPU→CPU→GPU 工作控制。反馈环忙时，sticky failure 防止下一帧擦掉尚未观察到的失败。修改预算后重新加载可以重试。

独立 CPU 全量布局检查：4,635 个激活页，展开为 6,173 个物理槽，共 1,618,214,912 bytes（1,543.25 MiB）。因此默认几何池为 2,048 MiB；1,536 MiB 连完整 bootstrap 都放不下。Loader 不拥有长期 GPU 资源，Renderer release/destroy 负责退休，source handle 在 GPU owner 释放后关闭。

## 参数

参数支持面板操作和 URL，范围/容量参数重新加载生效。

| 参数                      |       默认 | 含义                                                                 |
| ------------------------- | ---------: | -------------------------------------------------------------------- |
| `packStart` / `packCount` |      0 / 0 | 默认全量，0 数量加载到末尾                                           |
| `geometryMiB`             |       2048 | 四 bank 几何总容量；单 bank 为请求值 / 4，设备实际能力可降低实际容量 |
| `metadataMiB`             |        192 | 固定 Product 元数据目录，独立于几何 payload                          |
| `frameMiB`                |        512 | 单视图 Frame geometry arena 上限                                     |
| `frameOwnerMiB`           |       1024 | 所有 live view / 未退休 workset 的 Frame arena owner 总上限          |
| `workMi`                  |          4 | GPU 帧队列槽数 / 1,048,576，范围 0.0625–16；实际溢出为明确失败       |
| `reads`                   |          8 | 流送并发 Range 读取硬上限                                            |
| `inFlightMiB`             |         32 | 流送在途数据硬上限                                                   |
| `uploadMiB`               |         16 | 每帧页上传硬上限                                                     |
| `sse`                     |          4 | LOD 像素误差；更小通常更细                                           |
| `hzb` / `cone`            |      1 / 1 | GPU 遮挡 / Cone 剔除                                                 |
| `view`                    | meshlet-id | Meshlet、Visibility、材质、深度与材质通道视图                        |
| `extent` / `scale`        |   1080 / 1 | 输出 1080p、内部 100%；支持 720、1440、window 与 0.75、0.5           |
| `taa` / `ao` / `bloom`    |  0 / 0 / 0 | Temporal、GTAO、Bloom；低于 100% 比例会启用现有 upscaler             |
| `orbit` / `speed` / `fov` | 0 / 2 / 60 | 自动相机巡航、速度、FOV 度数                                         |
| `profile`                 |     timing | off / timing / counters / heavy / full                               |

流送 scheduler 的自适应预算仍在硬上限内工作；实际预算与压力显示在详细状态。这个示例关闭物理环境与 VSM，侧重几何；PBR 使用现有场景照明默认值，模型没有贴图。

CPU / RAF / GPU Command Span 显示最近 360 帧 P50/P95。Command Span 包括编码范围内 copy、clear、间隙和采集开销，不能当显示延迟；Span、stage、pass 分别列出，不相加重复统计。`full` 逐 Pass 计时最多 120 个采样帧，随后引擎转 coarse；实际计时模式始终显示。关闭采集时没有 GPU 性能样本。

定时采样支持预热和记录时间；GPU 晚到结果按 frameIndex 更新，保留 1 秒 drain。相机手动操作、配置改变、暂停、后台与释放会中断记录并保留原因；巡航采样记录初始视角与速度。JSON 包含条件、帧、资源、流送、工作容量、设备信息和失败。未完成 readback 仍以 pending 留在导出中。

空格暂停，H 收起面板；支持单帧、近景、全览、中止与资源释放。面板 500 ms 更新，不在每帧读取完整流送 evidence；完整 JSON 诊断本身有 CPU 开销。

## 容量调整与成本

引擎 Frame arena 默认单视图上限从 128 提高到 512 MiB，owner 总上限从 256 提高到 1024 MiB。公开的 `RendererConfig.frameGeometry` 可分别设置 `maxBytes`、`ownerMaxBytes`，初始化后固定，恢复重用同一配置；不改变 shader ABI、唯一 writer、提交或 fence 退休。

Cost Card：上限增加不预分配内存。物理队列按 `min(理论上界, 请求容量)` 分配，而理论量与实例不变；全量默认 MeshletWork 约 96 MiB、Frame arena 约 116 MiB。原先按理论量分配的单 MeshletWork 将超过 9.9 GiB，既超设备 binding limit，也不能作为 GPU 可见量的准入依据。Traversal 两队列与 VisibleCluster 仍按完整理论上界，分别约 136.5 MiB、264.9 MiB；本轮未重构这些队列。

只有理论量超过物理队列的 Product workset 启用 sticky failure 和必要状态反馈。main/shadow 各至多新增 3×32 B staging；每提交帧各多一次 32 B copy 和一次延迟 map，无新增 submit、dispatch、pipeline 或 shader binding。准备 entry 单 invocation 多两个已有 header atomic loads，无新 ALU heavy loop、samples 或 barrier；无失败时生成/LOD/剔除数学与写域不变。0/50/100% 可见率均支付配置队列容量税，实际 GPU 工作仍按 compact count；管理反馈是完整性成本，不宣称省时或净性能改善。上限 4M 的完整 GPU 实测帧产生 651,095 条，overflow/invalid=0；未证明所有视角、所有 SSE 都适合该容量，超出会拒绝并提示提高 `workMi`。设备限制在 GPU buffer 创建前检查。

Source Map（Reference / Local）：核读 Nyx 固定 revision `bc7e5b1e51f6b3b8af4771db81ffaa714fcbe64b`、MIT，`MiniEngine/Model/StructsIO.h` 的 4M visible / 16M candidate 默认、`CommandBucketer.cpp::Initialize` 的物理队列，以及 `Shaders/DAGCull.slang::ProcessNodeBatch/ProcessMeshletBatch` 的 actual work 压缩；本地 DAGCull SHA-256 与既有 `docs/porting/nyx-function-map.json` 一致。参考逻辑/物理容量分离；没有移植上游 persistent globally-coherent traversal、wave、mesh shader 或溢出 clamp。本地映射为 `GeometryProductWorkload::geometryProductMeshletWorkCapacity` → `PackedVisibilityPass/ShadowGeometryWork` → `VirtualGeometryMeshletWorkCandidate` → `GeometryPageStreamingRuntime` 的完整失败反馈，不宣称新的来源 adoption。

验证命令：

```powershell
yarn typecheck:zorah
yarn build:zorah
```

正式整 Renderer 性能与画质验收不由此示例替代。
