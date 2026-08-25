# 搜索流程

1. 用 `CONTEXT-MAP.md` 选择领域和首选搜索根。
2. 先用 `rg --files <root>`、`rg -l`、`rg -c` 查看分布。
3. 定位定义、真实调用方、资源 producer/consumer 和相邻验证。
4. Shader 同时追踪 CPU bindings、Pipeline、实际 import 和生成来源。
5. 只有定义不足或符号跨 seam 时扩大到其他目录。

性能路径必须同时追踪：

```text
CPU 创建/更新
→ command encoding
→ Buffer/Texture ABI
→ Shader producer
→ indirect/direct consumer
→ timestamp/counter/readback
```

不得仅因文件名包含 `cull`、`indirect`、`visibility` 就判断功能已接入。

