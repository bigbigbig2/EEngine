# M14 · Browser — 设计意图

> 母本：docs/source/webgpu-browser-limits.md 全文；设计 v2 P10

## 1. 身份

```txt
不是可选工具代码
是「网页里跑 Shade-like 核」的外壳模块
```

## 2. 必须覆盖的母本主题

```txt
device lost 与重建
visibility / 后台节流
Memory Saver 类回收后的恢复
DPR 与 internal scale
主线程 vs worker 的边界意识
与 temporal history 的联动（调 Post）
```

## 3. 成功标准

```txt
切标签页、回前台、压力回收后：可定义行为，而非未定义崩溃或脏 history
默认分辨率策略不会在高 DPI 上静默 4× 像素自爆
```
