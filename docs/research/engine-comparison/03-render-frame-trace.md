# 单帧调用链追踪

本页是第一轮源码阅读工作台。完成后可拆分为两篇正式专题。

## 1. 固定测试场景

为了让两边可比较，先约定最小场景：

- 一个透视相机。
- 一个方向光。
- 一个不透明 PBR 材质。
- 一个静态几何体，先单实例，后扩展到大量实例。
- 固定画布大小、无 XR。
- 第一轮关闭非必要高级效果；第二轮再逐个开启。

## 2. three.js 跟踪表

| 阶段 | 调用点/符号 | 输入 | 输出/副作用 | CPU/GPU | 证据 |
|------|-------------|------|-------------|---------|------|
| renderer 入口 | 待填 | | | | |
| scene 更新/遍历 | 待填 | | | | |
| 可见性判断 | 待填 | | | | |
| render list 构建与排序 | 待填 | | | | |
| render object 准备 | 待填 | | | | |
| pipeline/binding 准备 | 待填 | | | | |
| backend 编码 draw | 待填 | | | | |
| submit/present | 待填 | | | | |

## 3. reconstructed 跟踪表

| 阶段 | 调用点/符号 | 输入 | 输出/副作用 | CPU/GPU | 证据 |
|------|-------------|------|-------------|---------|------|
| renderer 入口 | 待填 | | | | |
| scene/database 同步 | 待填 | | | | |
| framegraph 构建 | 待填 | | | | |
| instance culling | 待填 | | | | |
| meshlet culling | 待填 | | | | |
| work expand/sort/bucket | 待填 | | | | |
| visibility/depth | 待填 | | | | |
| material resolve/lighting | 待填 | | | | |
| temporal/post | 待填 | | | | |
| submit/present | 待填 | | | | |

## 4. 对齐后的控制流

追踪完成后，用同一组概念重写两边流程：

```txt
输入变化
  → 数据同步
  → 候选集合
  → 可见集合
  → 工作分组
  → 几何/可见性输出
  → 材质与光照
  → 后处理
  → present
```

不要强迫两边步骤一一对应。若某一步在一边不存在、合并在别的 module 中，或跨 CPU/GPU 分布，这本身就是需要记录的架构差异。

## 5. 第一轮应采集的量

- CPU：scene update、候选构建、排序、命令编码、submit 前总耗时。
- GPU：culling、visibility/depth、shading、post 的 timestamp。
- 数量：对象、实例、meshlet、材质、pipeline、draw/indirect draw、可见项。
- 内存：buffer/texture 总量、暂存峰值、每帧上传字节数。
- 缓存：pipeline、binding、geometry、texture 的命中/重建情况。

所有测量都记录浏览器版本、操作系统、GPU、分辨率、DPR、warm-up 帧数和采样方法。

