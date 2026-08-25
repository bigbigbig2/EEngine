# Layer 3 · Shade-like 渲染核设计意图

> 严格依据：设计 v2 Layer 3；Shade 解读 v3 §4–§12 主线；docs/source/comparison-three-vs-shade.md 性能账  
> 不写实现级 shader/伪代码细则（母本附录级内容后挂模块）

## 1. 核心思想（Shade v3 §4）

### GPU-resident

场景关键数据长期在 GPU，例如：

```txt
instance / transform
geometry / meshlet
material id / 纹理句柄或槽位
光数据
animation（路线中的方向）
bounding volumes
indirect draw buffers
visibility / depth pyramid
```

CPU 角色：

```txt
提交 frame 命令
上传变更
业务与加载
而不是每帧当「全场景渲染列表指挥官」
```

### GPU-driven

```txt
GPU frustum / occlusion
meshlet expansion
visible list / indirect
compaction / scan 等
（路线中）animation / bounds 更新
```

### 对 Web 为何重要（Shade + 对比 + 局限）

```txt
JS 主线程还要 DOM/UI/业务/GC
每帧几十万对象 + 海量 draw 在 Web 上极易卡
策略：把 per-object CPU overhead 压到最低
```

## 2. 主渲染意图链（Shade v3 §5 + 设计 v2 §5）

概念阶段（名称级）：

```txt
1. Instance culling → visible / maybe / culled
2. Mesh → meshlet expansion（细粒度）
3. Meshlet culling
4. Visibility buffer raster（记录看见谁，不做贵材质）
5. Depth pyramid / HZB
6. 处理 maybe set（progressive occlusion）
7. 再 raster 确认部分
8. Material id / material resolve（可见像素材质）
9. Lighting / 阴影
10. TAA 与后处理栈、GI 等
```

精神一句话（Shade）：

```txt
先解决可见性，再解决材质与光照。
```

## 3. Visibility Buffer 为何是中枢（Shade §6 + 对比 §4）

相对传统先写满 G-buffer 材质：

```txt
VB：首 pass 轻，只记 mesh/triangle 等 ID
材质与纹理在后续按需、按可见像素组织
利：大场景、多材质、少无效 shading
弊：带宽、数据结构、无 bindless 时纹理访问难
```

与 Nanite 精神相关但不可等同（Shade）：

```txt
无 mesh shader、无原生硬件 RT、无 bindless、无 UE 离线全家桶
浏览器 JS/WebGPU 环境
```

## 4. Meshlet（Shade §8 + 设计 v2 §8）

```txt
细粒度 cull / 局部性 / 适配 VB
WebGPU 无 mesh shader → compute + indirect 模拟
注意 expansion 的 thread divergence（Shade #92）
→ batch 等工程手段属于实现层，设计层必须承认该问题存在
```

## 5. Material 阶段（Shade §9 + 对比）

```txt
目标：昂贵材质逻辑对最终可见像素执行（接近 0 overdraw 的 material shading）
组织：可按 material 分发（Shade：draw 与材质数相关案例）
代价：材质多则 pass/draw 上升；管线与绑定管理重
```

## 6. 集成后处理与 TAA（Shade §11–12 + 对比 §8–9）

```txt
TAA / GTAO / SSR / Bloom / Exposure 共享 depth、normal、
motion、history、噪声与 disocclusion

TAA 是 intrusive：整条管线要知道 jitter / history
不是 EffectComposer 外挂一个 Pass 就等价

Deferred 路径常选 TAA 而非简单 MSAA 全家桶
```

GI / SSR / 阴影等：母本与 Shade 均列为 **引擎重要部分**，设计文档保留为目标能力；具体算法演进（DDGI→SVLM 等）见 Shade 时间线，工程上可分阶段落地，但 **不得从目标身份中抹掉**。

## 7. 性能账（docs/source/comparison-three-vs-shade.md）

```txt
换走的：
  CPU draw call 爆炸
  传统 overdraw 上的材质浪费
  弱 occlusion

换来的：
  GPU compute 与结构复杂度
  高 bandwidth
  调试难
  小场景固定成本可能不值
```

## 8. 与 Layer 1/2 的接口意图

```txt
Layer 3 只认：GPU 表、pass 图、帧常量、设置项
Layer 3 不认：THREE.Mesh 指针遍历作为主路径
Layer 1 的材质参数语义应对齐 three Standard 等约定（设计 v2），
以便「用原来的 PBR 想法」而不是另起一套外观语言
```
