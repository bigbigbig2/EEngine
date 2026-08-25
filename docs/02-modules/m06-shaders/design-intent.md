# M06 · Shaders — 设计意图

> 母本：设计 v2 §18 不使用完整 TSL；对比 TSL 是 three 路径现代化不是 GPU scene

```txt
WGSL + fragment 组合 + 变体
PBR 语义可参考 three，编译路径自主
完整 TSL/Node 不作 GPU-resident 内核
与 bind group ABI、无 bindless 布局策略一致
```
