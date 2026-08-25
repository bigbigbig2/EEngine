# M01 · Engine — 设计意图

> 母本：设计 v2 WebGPU-only / Engine；docs/source/webgpu-fundamentals.md（Device/Pipeline/Command）

```txt
唯一 GPU 设备与资源入口
显式 pipeline / bind group / command 模型（系统学习）
支撑 FrameGraph 与全部 Layer 3 pass
处理 device lost 出口（与 M14 协作）
不承载 three 场景语义
```
