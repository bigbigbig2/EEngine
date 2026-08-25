# M05 · FrameGraph — 设计意图

> 母本：设计 v2 §3.5、§17；Shade v3 §10

```txt
调度 Shade-like 多 pass（cull/VB/light/TAA/SSR/GI…）
资源生命周期与别名（Bloom/SSR 共享等思路）
不是 three EffectComposer 插件链换皮
连接 compute / raster / fullscreen / temporal
```
