# R2-B Complete Geometry Package

设备无关的完整纵切：

```text
attributed + multi-material SourceGeometry
→ Meshlet / renderable Cluster hierarchy / geometric error
→ unquantized conservative BVH8
→ uncompressed vertex streams / u32 indices / material ranges
→ package reopen + full validator + CPU selector
```

页面显示 source/recipe/content/file hash、bytes、Meshlet/Cluster/BVH8 数、depth、error distribution、warnings 与 coarse/fine CPU selector 计数。`openGeometryAssetPackage()` 只读取和验证最终 bytes，不执行任何 Meshlet、simplify、hierarchy 或 BVH build。GPU upload/residency 和 GPU traversal 不属于这个页面，分别由 R2-C 与 R3 验收。
