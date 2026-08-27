# R2-B-01 Meshlet Cooker

浏览器纵向验证官方 `meshoptimizer@1.0.0` WASM 与 OEngine 新 Geometry package seam：

```text
16 × 16 Grid SourceGeometry
→ 32/64、64/64、64/128 recipes
→ GeometryDirectory + Meshlet sections
→ package reopen + Geometry validator
→ triangle coverage / variant golden / byte-identical rebuild
```

页面不创建 WebGPU device 或 GPU 资源。R2-B-01 只证明设备无关 Cooker、ABI 和 validator；hierarchy/error、BVH8、完整 streams/material sections 分别属于 R2-B-02/03/04。
