# M12 · Lighting — 设计意图

> 母本：设计 v2 lighting/shadow；Shade 光影/GI；对比高端效果集成

```txt
消费 G-buffer 或等价：直接光、IBL
阴影（CSM/contact 等）为路线能力
GI 与探针/SVLM 等与 Shade 路线对齐为方向，可分期
与 M13 temporal 协同，而非孤立全屏滤镜
```
