# Surface V3 五步修复执行记录

目标：[五步计划](surface-work-v3-classifier-store-repair-plan-2026-10.md)。起点为 `0bc4e68752ab187a1b508f7a1952e6ebe18bec02` 加计划已核对的 dirty 修改；起点 diff 保存在本机 `.local/surface-repair/start-dirty.patch`。不将 dirty 起点宣称为 clean HEAD。

## 步骤 1：独立引用、物理合同和发布边界

实现：代表并集与字段/信号需求保留，明确传递 batchTileCapacity/firstTile；input witness 只修改自己的身份位，不覆盖字段需求。Constant/Default/Zero/Transient 字段引用从实际 plane 与便宜 publication 身份解析；纯常量和 E-only 不分配完整 GeometryRecord。实际 reconstruct 读取独立 E、baseColor/metallic、occlusion、scalar AO；Denv 为未着色 irradiance，`1/pi` 只在 compose 使用一次，direct 保留生产 BRDF 已着色 residual，specular/coat 仍为独立 radiance。工作色域转换和 pre-exposure 保持在最终合成边界。

FieldStore/SignalStore 独立 state CAS 选唯一 slot writer，payload/key 写完后由后续 dispatch 发布可读状态；没有按首 key word 相等共享 writer，也没有跨 workgroup 自旋。SignalStore packet semantic/spill 与 state/generation 分开；touched epoch CAS 使用实际旧值，同一 submitted frame 至多推进一次 age/confidence。HDR spill 每个 packet 有有界精度位置，不在 spill 满时发布半精度 Inf。容量 profile 包含当前最坏 packet/request/owner 字节。

已运行：`npm --prefix OEngine run build:test`；18 项 `surface-cell-plan / surface-field-store / surface-signal-store / surface-batch-consumption / surface-history-binding` 定向测试通过。真实 Chrome 154 GPU fixture 执行独立代表映射 192 次、FieldStore/SignalStore 各四个同前缀完整 key 碰撞、RESERVED→下一 dispatch PUBLISHED、实际 production packet shader 语法与 planner pipeline 编译，以及 production reconstruct 的 E-only、棋盘 albedo×irradiance×细率 AO、direct residual+E、部分覆盖、空 tile（每例 64 像素）；无 GPU validation/page error。报告 `.local/validation/surface-repair-step-one/repair-step-one-browser.json`。

检查期间修复：共享字段 reader 使用 WGSL 保留字 `ref`；GPU fixture AO buffer 不足。修复后只重跑受影响 GPU fixture。最后补正缺失 alpha 的默认值及 FieldStore published gate。

未运行：1080p Showcase、完整 Lighting GPU 出图、连续画质与性能采样；按计划归属步骤 4/5。仍需步骤 2 共享可组合证书、步骤 3 前置完整 value/certificate lookup 与精确失效、步骤 4 full-key request dedup 与实际需求调度；旧 19-word record gate 不是最终 FieldStore 身份，后续替换，不能将本步骤称为整链完成。
