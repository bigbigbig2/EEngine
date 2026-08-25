# 数据流（设计意图）

> 依据：设计 v2 §5.1；Shade v3 §5；docs/source/comparison-three-vs-shade.md 的 CPU/GPU 分工  
> 本文描述 **意图与阶段**，不绑定具体 API 名实现。

## 1. 编译 / 导入期（低频）

对应设计 v2：three → Lite stores → GPU tables；Shade：加载后数据常驻。

```txt
THREE.Scene / glTF 等（Layer 1）
        │
        │  traverse 一次（导入时允许；不是每帧 render-list）
        ▼
提取：geometry 属性、材质参数、纹理、灯光、相机、变换
        │
        ▼
Lite World：plain data + id（Layer 2）
        │
        ▼
（可选）meshlet bake、纹理策略整理
        │
        ▼
GPU Scene Tables 上传（Layer 2/3 接合）
        │
        ▼
场景关键数据 GPU-resident
```

原则：

```txt
Authoring 可以保留树
渲染消费的是表
导入期可以重；帧循环必须轻（对比 + Shade）
```

## 2. 帧循环（高频）——目标形态

设计 v2 §5.1 + Shade 一帧精神：

```txt
CPU / JS：
  输入与业务
  相机与少量全局
  dirty：transform / material / texture 等增量
  frameGraph.execute()

GPU：
  UploadDirty（仅变更）
  Culling（instance → 可选 meshlet）
  Meshlet expansion（若启用）
  Visibility raster
  Depth pyramid / HZB
  Maybe-set resolve（progressive occlusion）
  Material resolve
  Lighting
  TAA / SSR / GI / shadows / post
  Present
```

概念链：

```txt
World
  → GPUSceneTables
  → Culling → Visible lists
  →（Meshlet）
  → VisibilityBuffer + Depth
  → DepthPyramid
  → MaterialResolve → GBuffer
  → Lighting → LitColor
  → Temporal / SSR / GI / Bloom / Tonemap
  → Swapchain
```

## 3. 与 three 传统帧循环的对比（docs/source/comparison-three-vs-shade.md）

```txt
传统 three：
  每帧 traverse → render list → 大量 per-item draw

目标：
  每帧少量 dirty + 固定/准固定 pass 图
  可见性与绘制任务在 GPU 侧生成与筛选
```

## 4. 动态更新（设计 v2 §4.3 精神）

```txt
transform dirty  → 更新 transform / bounds 相关表
material dirty   → 更新 material 表与管线/绑定相关键
geometry dirty   → 重上传几何，可能重建 meshlet（昂贵，少做）
texture dirty    → 重上传或更新 atlas/array 页

禁止作为主路径：
  每帧 full scene traverse 建 list
  每帧 flatten 全部对象
  每帧重建全部 GPU buffer
```

## 5. 资源从网络到 GPU（docs/source/webgpu-browser-limits.md §3–4）

Web 路径常见：

```txt
网络 → 解压/解码 → JS/WASM 内存 → GPUBuffer/GPUTexture → 上传
```

设计意图：

```txt
少量大块传输
流式与压缩格式
worker 解码
增量上传
避免 CPU↔GPU 无谓往返
上传完释放 CPU 临时副本
```

**渲染架构再强，加载/解码/上传仍可拖垮体验**——母本要求资源系统被认真对待，不是「只写 renderer pass」。

## 6. 时间域与标签页（docs/source/webgpu-browser-limits.md §5 + Shade TAA）

```txt
TAA / SSR / temporal GI 依赖 history
页面隐藏：rAF 可能停、资源可能被回收
恢复：device/context 校验、history 不可盲目信任、可能 warm-up
```

数据流上，history 缓冲与「页面可见性」是同一条产品链路，不是后处理插件私货。

## 7. docs/source/webgpu-fundamentals.md 在数据流中的位置

```txt
Adapter/Device/Queue/Pipeline/BindGroup/CommandEncoder
是 Layer 2/3 的 API 词汇表
不改变「表驱动 + pass 图」的产品数据流
```
