# Stories

`generated/` 由 `scripts/generate-stories.mjs` 根据 `demos/**/example.json` 生成。

Story 只负责 metadata 和 iframe 宿主，不得导入 OEngine、创建 Renderer 或申请 WebGPU 设备。
