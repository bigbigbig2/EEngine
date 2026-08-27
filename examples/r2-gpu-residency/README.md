# R2-C GPU Residency

固定输入为 24×24、双材质的完整 Geometry package。页面在一个 caller-owned
command/submit 中完成：

```text
validated package
→ Geometry/Cluster/Meshlet/BVH8/stream payload residency
→ GPU ABI roundtrip
→ Compute 写 drawIndirect args
→ 固定功能 Hardware Raster 消费
```

期望：画面出现完整彩色波浪网格；JSON 中 `passed=true`、`nonBackgroundPixels>0`、
`privateSubmitCount=0`、`committedGrowCount>0`、ABI count 与 package 一致、abort
不增加 resident asset，release 后旧 handle 失效。该示例只验证 R2-C 的 flat
Hardware consumer；GPU hierarchy/SSE traversal 属于 R3。

本地验收：

```powershell
cd examples
npm run dev:host
```

打开终端输出的 `/r2-gpu-residency/` 地址，确认页面显示“验证通过”、彩色网格非空、
机器报告 `passed=true`，并检查控制台没有 WebGPU warning/error。应用内浏览器无法
启动时，把该页面结果作为唯一人工门禁；不要用 production build 代替画面验收。

2026-08-27 首次人工 live 门禁已通过：625 vertices/1,152 triangles，package
44,176 B、29 Meshlets、16 Clusters、9 BVH8 nodes；GPU roundtrip expected/actual
一致，512×512 readback 得到 211,600 个非背景像素，validation/uncaptured/shader
diagnostics 均为空，abort/release 与 `privateSubmitCount=0` 通过。该结果是正确性证据，
`adapter.info` 未被浏览器 JSON 序列化，因此不作为跨机器性能 artifact。
