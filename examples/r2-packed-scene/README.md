# R2-D Packed Scene Vertical

该页面用一份已验证 Geometry package 和一张连续 Instance table 验证：

```text
1k / 10k / 100k structure-of-arrays source
→ GpuScene bulk/grow
→ 0% / 1% / 10% / 100% explicit patch
→ Compute 读取 InstanceRecord，压紧 visible indices 并写完整 16 B drawIndirect
→ Hardware Raster 同时读取 InstanceRecord 与 GeometryRecord/vertex payload
```

Packed source 只保留 typed arrays 和少量 geometry handles，不构造一实例一
`Mesh/Node3D`。普通 Scene 使用 `createInstanceSourceFromScene()` 写入同一个 ABI。
页面还会 readback 一个同帧重复 transform patch，确认 v2 `previous_from_current`
始终把最新 current 映射到上一帧 transform。

本地验收：

```powershell
cd examples
npm run dev:host
```

打开 `/r2-packed-scene/`，确认画面出现 1,000 个彩色三角形，机器报告
`passed=true`、三档 bulk 完整、四档 patch density 完整、stable no-op 没有 upload，
并检查 validation、uncaptured error 与 shader diagnostics 为空。CPU 时间只用于同页曲线，
不作为跨机器性能结论。

2026-08-27 干净 live 浏览器门禁已通过：1k/10k/100k CPU pack 约
1.7/6.1/26.6 ms，111k active records；四档 transform/material patch 完整，stable
encoded copy 为 0 且 upload bytes 不变；same-frame current/previous readback 与期望一致；
1,000-instance Hardware consumer 得到 41,733 个非背景像素。WebGPU validation、
uncaptured error、shader diagnostic 和干净标签页 console warning/error 均为空。
该段是 G2 关闭时的 v1 历史证据；页面已升级为 ABI v2 motion readback，本轮只完成
production build，新的 live 浏览器 JSON/diagnostics 尚待重采。
