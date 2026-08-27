# R2-A Package Kernel

该页面通过相对路径导入 `OEngine/src/index.ts`，执行程序化 Box → `SourceGeometry` → Package v1 writer → async open/validate，并破坏 payload 验证 checksum/content hash 拒绝。

预期：

- 页面显示“验证通过”和 `PASS`；
- Box 为 24 vertices / 12 triangles；
- package validation 为 valid；
- corruption issues 至少包含 `section-checksum-mismatch` 与 `content-hash-mismatch`；
- 控制台无异常。

这是 `R2-A-03` 的浏览器/生产构建验证，不是 GPU residency、Hierarchy 或渲染性能示例，不要求 WebGPU adapter。
