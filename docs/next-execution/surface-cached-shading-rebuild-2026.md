# Surface 缓存与稀疏照明重构执行计划

日期：2026-10-01。目标：[最终设计](../next-design/surface-cached-shading-final-2026.md)的全部要求。起点：`09b220f9348700c53035d283bc4f03bc5d19764b` 的旧 Surface 生产链。用户允许分阶段提交；阶段完成不能代替整个重构完成。

## 1. 执行规则

- 每阶段交付最终主链需要的完整模块，不能把简单全率材质优化、空类或只通过源码字符串检查当成替代算法完成。
- 新生产消费者接入时同时切断相应旧消费者，不建立 A/B 生产开关。基础数据模块可先接入发布，尚未替换的旧生产消费明确标记为过渡事实，不报告性能目标已完成。
- 保留准确 glTF/Standard/Coated、采样、色域与 BRDF 数学；变更执行模型与变更算法行为分别登记。
- 复杂算法先完成来源 profile 与逐阶段映射。没有完整 donor 的部分使用具名本地算法，不冒称完整上游移植。
- 每大模块收口运行 typecheck、build、必要数值/容量/生命周期测试。真实编译失败必须修复。用户要求的最终专项 browser/画质/性能对比属于本目标，不能以其他 provider 尚未完成为由无限推迟；未来 GI/SSSR provider 的独立实现范围也不能被隐含声明已完成。
- 提交只包含对应阶段的连贯改动、中文动机/范围/实际验证。之前未提交的性能工具单独收口；用户新增 `neighbourhood_city_modular_lowpoly.glb` 不混入提交。

## 2. 阶段与切换

| 阶段 | 完整交付 | 删除/接通边界 | 完成证据与当前状态 |
| --- | --- | --- | --- |
| S0 设计与来源 | 明确输出字段、算法 profile、owner、全部要求追踪、验证范围；设定 active workstream | 新设计替代旧 Surface 目标，旧实现事实留在历史执行记录 | 本文件与来源映射；设计检查中 |
| S1 材质编译与 Appearance 产品 | 有类型 IR；常量折叠、输出/通道活性、等价采样、静态/动态/几何/视向依赖；固定材质 lowering；静态数据/烘焙产品与动态程序 | 材质发布消费真正编译产物；旧十角色循环在新 consumer 切入时删除 | 独立数值对照、变更/快照、过滤非等价负例、真实 GPU 编译消费；未完成 |
| S2 几何共享与稳定地址 | residency 属性准备；同帧 transform/shape 数据；winner-demand primitive coefficients；source domain/LOD mapping | raster 与 Surface 共用新几何数据；替换 workgroup 大 Setup；Loader 无长期 GPU owner | Native/WASM/Product、透视/近裁剪/非均匀变换/接缝/LOD 数值与真实 GPU 消费；未完成 |
| S3 新 Surface 主链与 Appearance 缓存 | 有界需求去重、页表/更新/淘汰、跨帧版本；简单源页与动态缺失统一消费；精简程序与必要字段 | 删除 Probe/旧 SampleWork/SampleResult/Resolve 调度生产依赖；完整全率覆盖是新主链合法模式 | 零工作、容量、缺页/失效、覆盖互斥、multi-UV/normal/ORM/coat；未完成 |
| S4 独立稀疏照明 | diffuse/specular/coat 分信号需求、cluster-local primary packets、当前变化强制刷新、正确灯表/阴影/环境/能量耦合 | 取消全屏完整 lighting 默认执行；删除旧 closure lighting | 光源/视向/阴影/cluster 边界、显露、精确参考与真实减量；未完成 |
| S5 历史与重建 | 各信号历史身份/年龄/footprint、曝光、空间重建、高频合成、Temporal/FSR3 reactive；间接 provider 的需求/历史消费 | 新 HDR 唯一 producer；无默认大 closure GBuffer；独立 provider 缺失如实记录 | 连续 motion/cut/显露视频、noise、SSR 法线需求、HDR/曝光 oracle；未完成 |
| S6 生命周期与逐条返工 | scene/product/device epoch、resize/cut/residency；旧 owner 删除；复核最终设计每条要求、清理陈旧测试/合同 | 唯一生产依赖图闭合；接口稳定后写正式 ABI/合同 | requirement audit、typecheck/build、真实 consumer/lifecycle；未完成 |
| S7 测试与性能验收 | 独立本地 Chrome 宿主、两 coverage 组、材质/场景/变化矩阵、独立旧 revision 对照、全部成本/P50/P95/画质 | 清除未证实的完成声明；未达目标继续返工 | Surface 至少下降50%、GPU pass合计至少下降30%，P50/P95均检查；未完成 |

S1–S5 的编号是实现依赖顺序，不是降低最终功能范围。静态烘焙、动态缓存、几何共享、稀疏照明、历史验证和重建均是必做项。允许同一模块内连续修改多个 owner；不为机械文件拆分制造阶段完成声明。

## 3. 设计要求到证明的追踪

所有条目初始为未完成。对应证据必须指出生产 producer、consumer 和测试覆盖范围；文件存在或 manifest 声称 completed 都不能替代证明。

| ID / 最终设计 | 必须证明 | 主要阶段 |
| --- | --- | --- |
| R01 / §1、§3 | 可靠全率 Visibility 与独立 material/lighting rates；同 FrameGraph/唯一 submit，无本帧 CPU 控制工作 | S2–S5 |
| R02 / §4 | 静态驻留属性与同帧 transform 真正共用，显存/带宽/被遮挡准备成本可见 | S2 |
| R03 / §4 | 可见 primitive 紧凑系数一次生产；透视、近裁剪、退化、非均匀变换正确 | S2 |
| R04 / §5 | 编译 IR 有输入/输出和通道依赖；常量/死输入去除、采样合并；保留全部当前材质语义 | S1 |
| R05 / §5 | 常量/源页、昂贵静态烘焙、动态缺失三种实际产品，不能只实现简单 glTF | S1、S3 |
| R06 / §5 | 多 UV/顶点/动态图正确，非线性过滤合同和不能烘焙的负例 | S1–S3 |
| R07 / §5 | 有限程序族/资源 profile，无运行时十角色通用循环；进入渲染前异步 PSO | S1、S3 |
| R08 / §6 | 稳定 source Surface 地址、各 LOD 映射、镜像/接缝/拓扑新 identity；不把 work index 当历史 key | S2、S3 |
| R09 / §6 | GPU demand 去重/有界分配/失效/淘汰/更新；camera与显露不错误清静态缓存 | S3、S6 |
| R10 / §6 | 字段与过滤独立；tangent-space normal和variance/roughness耦合；ORM/normal/coat没有整材质禁用规则 | S1、S3–S5 |
| R11 / §7 | direct diffuse与specular/coat按独立率执行，2×1/1×2/2×2真正在consumer减量 | S4 |
| R12 / §7 | 当前显露/光源/阴影/材质/视向变化强制刷新；bounded age与轮换校验 | S4、S5 |
| R13 / §7 | 连续primary执行、正确cluster灯集合与遮挡边界，不借代表灯表漏光 | S4 |
| R14 / §7 | diffuse、specular、coat能量/视向耦合保留；独立间接需求及真实可用provider消费 | S4、S5 |
| R15 / §8 | identity/变化/footprint验证、同域重建、低可信当前刷新、镜面漫反射分开 | S5 |
| R16 / §8 | FSR3不掩盖稀疏着色缺陷；显露/reactive传递；未预曝光缓存与色域一次转换 | S5 |
| R17 / §8 | 紧凑信号格式、真实消费者字段，无默认128-byte results或全屏完整closure | S3、S5 |
| R18 / §9 | owner唯一、bounded commit/消费、溢出同帧完整覆盖且无非法页、无跨组自旋 | S2–S6 |
| R19 / §9 | diagnostics编译裁剪，控制原子保留；发布检查不在每pixel重复 | S3–S6 |
| R20 / §9 | resize/cut/scene/product/device loss按域失效，不误清Appearance；capability创建前协商 | S6 |
| R21 / §10 | 所列旧文件/owner生产依赖全部删除，新HDR producer唯一 | S3–S6 |
| R22 / §11 | 固定来源/许可证/完整阶段映射；局部适配与本地算法不冒称完整移植 | 各阶段 |
| R23 / §12 | 25–35%及80–90%真实coverage，静止/运动/显露/灯光/材质/LOD/residency组合 | S7 |
| R24 / §12 | 净Surface与整帧P50/P95门槛；全成本、冷启动、缓存miss和所有慢帧；质量视频与负例 | S7 |

R14 不允许把尚未实现的 GI/SSSR 写成已完成。最终接受时必须逐项确认本次实际 provider 边界：已经存在的直接光、物理环境、AO、VSM 全部纳入；计划中 provider 需要的新需求/字段/历史消费不能靠空接口冒充。若目标实现需要它们的新算法，就继续实施和验证，不缩小本目标。

## 4. 已知证据与未完成事项

- 旧实现的本地诊断资料保存在 `.local/validation/`；它们包括热降频和中断运行，不能作为本重构的正式性能证据。
- 工作树中已有 performance lab、runner/analyzer 和 Showcase capture 工具。收口时修正 README、温控条件比较、失败/取消/冷启动处理；异步预热诊断不是生产同步编译故障修复。
- 原 Dungeon 是必须覆盖的真实内容；额外使用能分别暴露复杂材质、静态烘焙、动态参数、低roughness高光、双面/coat和接缝的受控资产。
- geometry既有画质与VSM完整遮挡缺口不因新缓存自动消失，出现相关失败时按真实owner修复。

## 5. 阶段记录

### S0：2026-10-01

已建立最终要求追踪与一次性切换范围，重新检查当前HEAD/worktree和owners。补查MaterialX固定源码作为图编译/静态烘焙参考；已有Wicked/The Forge/OSS来源继续按最终profile审读。当前尚未移植完整缓存、稀疏照明或时域算法。

本阶段不改生产代码，不运行build/browser/perf。设计结构检查不能证明运行时算法。后续状态按实际提交和测试结果更新。
