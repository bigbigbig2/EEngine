# Stage 0：证据基线与合同冻结

> 状态：设计完成，部分证据已采集；不是产品完成。
> 
> 目的：在替换任何效果算法前，冻结可复现的画面、GPU 时间、显存和资源图基线。

## 1. 为什么必须先做

当前问题不能只用“看起来抖”或“反射不对”描述。`Renderer` 仍直接拼接多个具体 Pass，AO、SSR、TAA 各自拥有部分 history/rejection 语义，且普通 `Scene` 与 Packed 路径并存。没有基线就无法判断一次改动究竟修复了算法，还是改变了分辨率、曝光或输入场景。

## 2. 固定输入

- 平台：桌面 WebGPU、独立 GPU、DPR 1。
- 默认 workload：1920×1080、中等偏高初始化配置，所有目标效果默认开启；测试可通过初始化参数关闭单项 Feature。
- 场景：静态高几何场景、动态灯光场景、室内 GI 场景、Local Reflection Probe/SSSR 场景、Temporal Stress 场景、Heavy Workload 场景。
- 每个场景固定相机路径、灯光路径、随机种子、曝光初值、DRS bucket、资产 hash 和 shader source hash。

## 3. 必须采集的证据

每个 session 输出到 `temp/r5-quality/<stage>/<commit>/<profile>/<session>/`：

- `environment.json`、`provenance.json`、`result.json`；
- FrameGraph、resolution domain、资源 lifetime、transient/history 显存；
- GPU timestamp：visibility、surface、lighting、AO、reflection、temporal、post、present；
- GPU producer/consumer counter：队列写入、消费、容量、overflow、fallback；
- 稳定帧和运动序列截图，不能只有单张截图；
- 控制台错误、设备丢失和 feature-off 对照。

## 4. 阶段执行

1. 先跑 smoke，确认 artifact schema 和证据链完整。
2. 在提交后的 clean tree 跑 full 三 session；用户已有 `three.js` gitlink 修改不能混入提交，但必须在报告中标识 dirty。
3. 记录问题到具体 `phase → resource → domain → shader`，不得直接归因于“参数不够”。
4. 为每个后续阶段冻结一个 paired A/B/C 输入，保持分辨率、曝光、相机和工作量不变。

## 5. 退出条件

- 三类证据（正确性、GPU 时间、显存）均可回查；
- 所有基准输入有 hash；
- 能证明 feature-off 不创建对应资源、history、readback 或独立 submit；
- 失败时能定位到真实 consumer，而不是只定位到 Feature wrapper。

未满足退出条件时，只修复采集器和证据链，不开始用参数掩盖画质问题。

