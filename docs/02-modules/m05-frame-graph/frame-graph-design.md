# M05 · FrameGraph 设计

> 母本：设计 v2 §3.5、§17

## 1. Task 模型意图

```txt
name
type: compute | render | fullscreen | copy | present
inputs / outputs 资源句柄
build：声明依赖与资源
execute：录制命令
```

## 2. 默认图（母本 §17.3）

```txt
BeginFrame
UploadDirtyScene
ResetCounters
CullInstances
ExpandMeshlets
CullMeshlets
RasterVisibility
BuildDepthPyramid
ResolveMaybe
RasterMaybeVisibility
MaterialResolve
DeferredLighting
SSR
GI
TAA
Bloom
Tonemap
Present
```

阶梯模式可挂接子集（见 `04-pipelines/modes.md`）。

## 3. 资源注册意图

```txt
desc：名、kind、format、usage、size 表达式
transient / persistent / external
history 标记 → 跨帧
```

## 4. Pass fusion（母本 §17.4）

```txt
浏览器 pass 过碎有 CPU 成本
允许合并小 compute、合并部分 post、批量 mip
融合后逻辑契约仍按 pass-contracts 理解
```

## 5. RenderBundle（母本 §17.5）

```txt
适用：静态 shadow、调试几何、fallback forward
核心 visibility 动态列表路径不一定适合
```

## 6. 与设置

```txt
关闭 SSR/GI/TAA = 从图中去掉 task + 资源
tree-shake：未链接模块不应强制进默认图
```
