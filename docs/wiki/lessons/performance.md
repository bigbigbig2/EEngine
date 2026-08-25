# Performance Lessons

## 功能更多不能解释性能更差

触发词：three.js、compute rasterizer、FPS、通用性、LOD。

现象：OEngine 实测明显慢于 three.js 两个 compute rasterizer 示例。

误区：用“功能更多、更通用”直接解释差距，或把差距只归因于缺少 LOD。

证据：当前帧同时存在多次 submit/readback、平坦候选展开、复杂 bucket/scan、逐 mip HZB、second-chance、每材质全屏 resolve 和多张全分辨率附件。

最快验证：先按 `docs/PERFORMANCE.md` 对齐画质，分别测 CPU submit、work generation、HZB、raster、material resolve 和 post。

结论：性能问题必须按资产候选、工作生成、光栅、着色带宽和运行时提交分层，现有架构没有保留优先权。

