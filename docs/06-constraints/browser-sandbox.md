# 浏览器沙盒约束

> 逐条对应 `docs/source/webgpu-browser-limits.md`，转为设计约束语言

## C-B1 进程身份

```txt
约束：应用是标签页，不是独占 OS 进程
设计：不得假设可占满 CPU/GPU/内存；必须可降载、可恢复
```

## C-B2 内存与回收

```txt
约束：浏览器/Memory Saver 可回收；device lost 可能发生
设计：资源生命周期可重建；监听 lost；大缓冲可解释的预算
```

## C-B3 网络加载

```txt
约束：资源常经 CDN/解码，非本地 cooked 包默认
设计：加载、缓存、解码、流式与渲染核同等重要
```

## C-B4 传输多副本

```txt
约束：Fetch→ArrayBuffer→WASM/JS→GPU 多层
设计：减少临时副本；上传策略；resident 后避免每帧回传
```

## C-B5 可见性与节流

```txt
约束：后台 rAF/计时器可停；worker 可降优先级
设计：visibility 策略；temporal 效果暂停与恢复
```

## C-B6 主线程

```txt
约束：JS 主线程绑 DOM/事件/布局
设计：重活可规划 worker；渲染准备不默认塞爆主线程
```

## C-B7 多标签竞争

```txt
约束：GPU/带宽与其他页共享
设计：性能结论注明环境；自适应质量
```

## C-B8 DPR

```txt
约束：高 DPR 使内部分辨率暴涨
设计：max DPR、render scale、半分辨率后处理/ GI/SSR 等
```

## C-B9 用户预期

```txt
约束：网页要快开、低打扰
设计：画质分档强制存在；不是「默认全开 AAA」
```
