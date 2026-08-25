可以，专门从**性能架构**角度看，三者大概是这个关系：

```txt
WebGLRenderer：
  three.js 传统 CPU-driven renderer + WebGL 状态机

WebGPURenderer：
  three.js 传统 CPU-driven scene/render-list 架构 + WebGPU/WebGL2 backend + TSL/Node 系统

Shade：
  WebGPU GPU-resident / GPU-driven renderer，从数据结构和渲染管线层面重写
```

所以性能对比不能只说：

```txt
WebGPU > WebGL
```

更准确是：

```txt
WebGPURenderer 的底层 API 更现代；
但它的上层 scene/render-list 架构还是 three.js。

Shade 不只是换 API，而是把“谁管理场景、谁剔除、谁生成绘制任务、谁做可见性”都改了。
```

------

# 1. 总体性能定位

| 维度         | WebGLRenderer                                    | WebGPURenderer                                            | Shade                                                        |
| ------------ | ------------------------------------------------ | --------------------------------------------------------- | ------------------------------------------------------------ |
| 核心目标     | 成熟、兼容、稳定                                 | three.js 新一代 renderer，优先 WebGPU，可 fallback WebGL2 | 高端 WebGPU renderer / GPU-resident scene                    |
| 性能提升来源 | WebGL 驱动优化、three.js render list、instancing | 更现代的 GPU API、pipeline/bind group、TSL、compute 能力  | GPU culling、meshlet、visibility buffer、GPU scene、deferred shading |
| CPU 压力     | 高，尤其大量 Object3D / draw call                | 比 WebGL API 层更现代，但 three.js 场景遍历仍在 CPU       | 极低目标，作者目标就是 millions of instances with little CPU overhead |
| GPU 压力     | 取决于 overdraw、材质、后处理                    | 可以更好利用 WebGPU，但仍偏传统 draw pipeline             | GPU 压力更大，特别是 bandwidth，但减少无效 shading           |
| 大场景能力   | 中等，靠 instancing / merge / LOD                | 比 WebGLRenderer 更有潜力，但不是根本重构                 | 最强，目标就是大场景、多实例、多材质                         |
| 小中型场景   | 很稳，可能最快/最省心                            | 未必总比 WebGLRenderer 快，取决于实现和浏览器             | 架构成本高，未必划算                                         |
| 高端效果     | 能做，但靠各种 pass 堆                           | 更适合新效果、compute、TSL                                | 从一开始就为 TAA、GI、SSR、deferred、postprocess 设计        |

three.js 官方文档把 `WebGPURenderer` 定位为 `WebGLRenderer` 的新替代方案，并说明它默认优先 WebGPU，如果不支持则 fallback 到 WebGL2；这说明它是 three.js 体系内部的新 renderer/backend，而不是像 Shade 那样重写整个渲染范式。([Three.js](https://threejs.org/docs/pages/WebGPURenderer.html))

------

# 2. CPU 性能：这是三者最大差异之一

## WebGLRenderer：CPU 很容易先成为瓶颈

`WebGLRenderer` 的经典流程是：

```txt
CPU:
  scene.traverse()
  update matrixWorld
  frustum culling
  build render list
  sort render list
  bind material
  bind geometry
  bind texture
  gl.drawElements / gl.drawArrays
```

瓶颈通常出在：

```txt
Object3D 数量太多
Mesh 数量太多
Material 数量太多
draw call 太多
透明物体排序
频繁切换 shader / texture / render target
JS 侧遍历和状态设置
```

它的性能特点是：
**少量大 mesh、少材质、合批好、instancing 做得好，就很快；大量小 mesh，就容易 CPU 爆。**

WebGL 本身是状态机模型，renderer 每次 draw 前要把当前 WebGL 状态准备好。three.js 的 `WebGLRenderer` 文档里仍然保留大量 render target、排序、scissor、effect、node compatibility 等传统 renderer 接口，这也说明它是围绕传统 WebGL 渲染状态组织的。([Three.js](https://threejs.org/docs/pages/WebGLRenderer.html))

------

## WebGPURenderer：底层 API 降低一部分开销，但 CPU scene 还在

`WebGPURenderer` 的性能优势不是“自动把 CPU 负担消掉”，而是：

```txt
WebGPU pipeline 更显式
bind group 更现代
command encoder / render pass encoder 更适合批量组织 GPU 工作
支持 compute
资源模型比 WebGL 更接近现代图形 API
```

但它仍然有 three.js 这层：

```txt
Scene
Object3D
Mesh
Material
Geometry
Camera
Light
render list
sort
per-object render item
```

所以大量 Object3D 的 CPU 遍历、render list 构建、材质/几何排序这些并不会因为换成 WebGPU 就消失。

更准确地说：

```txt
WebGPURenderer 减的是 WebGL API/backend 那部分旧负担；
但没有从根上消除 three.js CPU scene graph/render list 的负担。
```

TSL 文档里提到，TSL 的 `NodeBuilder` 目前有面向 WebGPU 的 `WGSLNodeBuilder` 和面向 WebGL2 的 `GLSLNodeBuilder`，并通过 `setup / analyze / generate` 构建 shader；这说明 WebGPURenderer 的重要变化之一是 shader/material 编译路径现代化，而不是把整个 scene 变成 GPU scene。([Three.js](https://threejs.org/docs/TSL.html))

------

## Shade：目标就是把 CPU 从渲染主循环里“踢出去”

Shade 作者明确说，他的目标是构建 **GPU-resident renderer**，可以实时渲染 millions of instances，并且 CPU overhead 很低；他也明确说 three.js WebGPURenderer 当前方向是 fairly traditional rendering architecture，和他做的东西在根本层面不兼容。([three.js forum](https://discourse.threejs.org/t/shade-webgpu-graphics/66969?page=3))

Shade 的 CPU 理想流程更像：

```txt
CPU:
  加载场景
  上传 buffer / texture
  更新少量全局参数
  发少量 compute/render pass

GPU:
  instance culling
  meshlet expansion
  occlusion culling
  visibility buffer
  material pass
  lighting
  TAA / SSR / GI / postprocess
```

所以在 CPU 性能上：

```txt
小场景：
  WebGLRenderer / WebGPURenderer 可能已经够快，Shade 不一定有优势。

超大场景：
  Shade 的架构优势会越来越明显。

大量实例：
  Shade 明显更有潜力。

大量独立 Mesh：
  WebGLRenderer 最容易吃亏，WebGPURenderer稍好，但仍受 three.js 架构限制。
```

------

# 3. draw call 性能：WebGLRenderer 和 WebGPURenderer 还是传统模型，Shade 是另一套

## WebGLRenderer

传统 three.js 里，一个 mesh/material 组合通常会形成一个 render item。哪怕 three.js 会排序和缓存 program，最终还是很接近：

```txt
for each render item:
  bind pipeline-ish state
  bind geometry
  bind material uniforms
  bind textures
  draw
```

所以它怕：

```txt
几千/几万个 draw call
很多材质切换
很多小物体
很多透明排序
很多 shadow pass 重复绘制
```

典型优化就是：

```txt
BufferGeometryUtils.mergeGeometries
InstancedMesh
减少 material 数量
减少 texture 切换
LOD
frustum culling
手动 batching
```

------

## WebGPURenderer

WebGPU 的 command buffer / pipeline / bind group 让底层提交模型更现代，但是 three.js 仍然要从 Scene 生成 render item。

所以它通常是：

```txt
draw call backend 更现代
pipeline / bind group 更明确
但是 render item 数量没有自动消失
```

这意味着：

```txt
如果你的瓶颈是 WebGL API 调用和状态切换：
  WebGPURenderer 有机会更好。

如果你的瓶颈是 5万个 Object3D 的 JS 遍历：
  WebGPURenderer 不会神奇解决。

如果你的瓶颈是复杂 shader / 大量像素 / 后处理：
  要看 WebGPU backend 和具体实现。
```

------

## Shade

Shade 的 draw call 思路完全不同。

作者在 #86 里说，一个包含 **111 个 unique PBR materials** 的 archviz 场景里，draw call 数大致等于材质数，也就是约 111；该场景还包含 158 张纹理、223 个 mesh、446,446 个三角形和 21 个 lights。([three.js forum](https://discourse.threejs.org/t/shade-webgpu-graphics/66969?page=5))

更关键的是他后面解释 Shade 一帧的几何可见性流程：

```txt
1. compute shader 过滤 instances：
   visible set / maybe set

2. visible instances 展开成 meshlets

3. visible meshlets 再处理

4. rasterize 到 visibility buffer：
   rg32uint，存 mesh_id + triangle_id

5. 构建 depth pyramid / HZB

6. 用 depth pyramid 处理 maybe set

7. 再 rasterize 剩余部分

8. 重建 depth pyramid 给下一帧使用
```

作者说，到这个阶段为止，实际 geometry drawing 只用了 **2 个 draw calls**，depth pyramid 大概还有 20 个 draw calls，但这些 pass 相对便宜。([three.js forum](https://discourse.threejs.org/t/shade-webgpu-graphics/66969?page=5))

这就是巨大差异：

```txt
WebGLRenderer / WebGPURenderer:
  draw call 数通常跟 render item / material / mesh 关系很强

Shade:
  几何阶段 draw call 数被压得很低
  material pass 再按 material 数处理
```

------

# 4. overdraw / fragment shading 性能：Shade 优势非常明显

这是 Shade 最狠的性能点之一。

## WebGLRenderer / WebGPURenderer

传统 forward 或 forward-like 渲染里，很多时候是：

```txt
一个 mesh 画上去
fragment shader 执行
后来被另一个 mesh 挡住
前面那次 shading 白算了
```

这就是 overdraw。

即使有 depth test，也会遇到：

```txt
透明物体 overdraw
alpha test / hashed alpha
复杂材质先执行一部分
多个 pass 反复画同一批几何
shadow pass 重复提交
postprocess 额外 bandwidth
```

如果场景复杂，像素 shader 很贵，overdraw 会非常痛。

------

## Shade

Shade 先生成 visibility buffer，然后 material pass 的思路是：

```txt
先知道每个最终可见像素看到哪个 mesh/triangle/material
再按 material 处理真正可见的像素
```

作者说，他会从 visibility buffer 取 `mesh_id`，再用一个 depth-only pass 把 material ID 写成 depth 值，然后每个 material 一个 draw pass，depth test 设为 equal。结果是 **material shader 对最终可见像素只运行一次**，作者甚至强调不是“几乎 0 overdraw”，而是真正按最终可见像素运行。([three.js forum](https://discourse.threejs.org/t/shade-webgpu-graphics/66969?page=5))

这对性能影响非常大：

```txt
复杂材质：
  Shade 更占优

高 overdraw 场景：
  Shade 更占优

多材质大场景：
  Shade 更占优

简单 shader 小场景：
  Shade 的额外 visibility/depth pyramid/buffer bandwidth 可能不划算
```

但这个代价也很明确：
作者自己说，这种方案在 material/texture/instance/geometry 数量上扩展很好，但代价是 **high GPU bandwidth**。([three.js forum](https://discourse.threejs.org/t/shade-webgpu-graphics/66969?page=5))

所以 Shade 不是“免费更快”，而是把性能账从：

```txt
CPU draw calls + overdraw + material switching
```

换成：

```txt
GPU compute + visibility buffer + depth pyramid + bandwidth
```

------

# 5. geometry / 大场景性能

## WebGLRenderer

WebGLRenderer 对大场景最怕的是：

```txt
很多独立 mesh
很多 Object3D
很多材质
很多 shadow caster
很多透明物体
很多动态对象
```

如果你把 100 万三角形做成一个或少数几个 mesh，它可能还行。
但如果是 10 万个小物体，每个都有 transform/material，CPU 会先炸。

性能优化主要靠：

```txt
合并 geometry
InstancedMesh
LOD
手写 culling
减少材质
减少 draw call
```

------

## WebGPURenderer

WebGPURenderer 对 geometry 的帮助主要来自：

```txt
WebGPU 更现代的 buffer / pipeline
compute 能力
更好的未来扩展空间
```

但默认 three.js 模式下，它还是不会自动把 mesh 变成 meshlet，也不会默认 GPU occlusion culling。

所以它的大场景性能可以比 WebGLRenderer 有潜力，但如果你不改数据组织方式，瓶颈仍然类似：

```txt
CPU scene graph
render list
draw item 数量
材质切换
shadow pass
```

------

## Shade

Shade 是 meshlet-based resident renderer。作者后面说 Shade 不是画整个 mesh，而是把 mesh 拆成最多约 128 个三角形的 cluster/meshlet 来处理。这样可以让 culling、visibility、LOD、occlusion 等更细粒度。([three.js forum](https://discourse.threejs.org/t/shade-webgpu-graphics/66969?page=5))

不过 meshlet 也不是绝对免费。作者提到，GPU 上把 mesh 展开成 meshlet 会遇到 coherence 问题：有的 mesh 只有 1 个 meshlet，有的高模树可能有 7,813 个 meshlet，导致同一工作组里部分线程空等。他后来加了一层 meshlet batch，把最多 64 个 meshlet 作为 batch，降低单线程极端循环长度。([three.js forum](https://discourse.threejs.org/t/shade-webgpu-graphics/66969?page=5))

这说明 Shade 的性能优化是非常底层的：

```txt
WebGLRenderer:
  优化 draw call / material / geometry merge

WebGPURenderer:
  优化 pipeline / bind group / TSL / compute

Shade:
  优化 GPU work distribution、meshlet expansion、visibility buffer、HZB、bandwidth
```

这已经是 renderer 内核级优化。

------

# 6. occlusion culling 性能

## WebGLRenderer / WebGPURenderer

three.js 常规主要是 frustum culling：

```txt
不在相机视锥内，不画
在相机视锥内，通常会提交
```

但很多时候：

```txt
一个物体在视锥内
但被墙挡住
被柱子挡住
被建筑挡住
被前景物体挡住
```

传统 three.js 默认并不会完整做 GPU occlusion culling。

所以复杂室内、大建筑、大遮挡场景里，WebGLRenderer / WebGPURenderer 会浪费不少 GPU 工作。

------

## Shade

Shade 明确把 conservative occlusion check 放在 compute culling 流程里，并用 depth pyramid/HZB 作为遮挡测试基础。([three.js forum](https://discourse.threejs.org/t/shade-webgpu-graphics/66969?page=5))

这类场景优势很大：

```txt
Sponza
室内建筑
城市街区
洞穴/走廊
大型 archviz
森林/地形遮挡
```

但如果是：

```txt
开阔地形
天空盒
少遮挡的草原
透明物很多
所有东西都可见
```

Shade 的 occlusion culling 收益会下降，甚至额外 pass 成本可能不太划算。

------

# 7. 材质 / 纹理数量性能

## WebGLRenderer

WebGLRenderer 里材质和纹理数量多，会造成：

```txt
shader program 切换
uniform 更新
texture binding
render list 分组复杂
cache miss
```

three.js 会做排序、program cache、texture cache，但 WebGL 的资源模型本身偏旧。

------

## WebGPURenderer

WebGPU 的 bind group / pipeline layout 比 WebGL 更现代，理论上更适合组织资源。
但 three.js 仍然需要把 Material / NodeMaterial 翻译成 pipeline 和 binding。

性能风险是：

```txt
pipeline permutation 多
NodeMaterial/TSL 编译和缓存复杂
bind group 更新频繁
大量材质仍然导致 render item 分裂
```

TSL 的优势是 shader graph 可以 analyze/generate，并且同一个节点只声明/包含一次，构建过程能做一定优化；但这更多是 shader 构建和表达能力优势，不等于自动解决大量材质 draw call 问题。([Three.js](https://threejs.org/docs/TSL.html))

------

## Shade

Shade 在 material pass 中按 material 处理，并利用 visibility buffer 让 material shader 只跑可见像素。作者说这种方式让 texture switching cost 很低，并且材质 shader 是 uniform 的，先输出 g-buffer，不在这个 pass 里做 lighting。([three.js forum](https://discourse.threejs.org/t/shade-webgpu-graphics/66969?page=5))

但 Shade 也遇到 WebGPU 资源限制。作者提到 WebGPU 默认 storage buffer 数量限制大约 8 个，很多平台最多推到 10 个；path tracer 这类 shader 需要 instances、geometries、materials、attributes、indices、lights、TLAS、BLAS、lookup table 等，很快就会撞上限制。([three.js forum](https://discourse.threejs.org/t/shade-webgpu-graphics/66969))

纹理方面也有问题：作者提到 Lumberyard Bistro 这类场景有 400 张纹理，而 WebGPU 的 `maxTextureArrayLayers` 默认是 256，因此单纯 texture array 无法覆盖更大场景；他认为真正理想的是 bindless textures，但 WebGPU 目前没有 bindless resources。([three.js forum](https://discourse.threejs.org/t/shade-webgpu-graphics/66969?page=5))

所以 Shade 的材质/纹理性能结论是：

```txt
可见像素 shading 非常强
材质数量扩展性强
但资源绑定、纹理数组、缺少 bindless 是 WebGPU 层面的硬限制
复杂度远高于 three.js
```

------

# 8. 抗锯齿 / TAA / MSAA 性能

## WebGLRenderer

WebGLRenderer 常见是原生 MSAA，优点是：

```txt
硬件支持成熟
边缘抗锯齿直接
成本可控
不需要整条 pipeline 感知 temporal history
```

缺点是：

```txt
对 shader aliasing、texture aliasing、specular aliasing 帮助有限
对 deferred/postprocess 管线不够统一
多 render target/deferred 场景下成本和兼容性复杂
```

------

## WebGPURenderer

WebGPURenderer 也有 `antialias` 和 `samples` 选项；官方文档里说开启 `antialias` 时默认使用 4 samples，也可以通过 `samples` 改。([Three.js](https://threejs.org/docs/pages/WebGPURenderer.html))

但这还是 MSAA 路线。它对传统 three.js 场景很实用，但不是 Shade 那种深度整合 TAA 的路线。

------

## Shade

Shade 是从一开始就把 TAA 当核心部分做的。

作者说 TAA 会让纹理略糊，因为它本身像一个 1 像素的 temporal blur kernel；他专门处理了两件事：
第一，从材质纹理采样 UV 里正确移除 TAA jitter；第二，对 mip level 做 bias，因为 TAA 等效提高了时间采样密度，否则纹理会偏糊。([three.js forum](https://discourse.threejs.org/t/shade-webgpu-graphics/66969?page=6))

这不只是画面质量，也影响性能。作者后面说他优化了 TAA filtering speed，使整体性能提升约 20%；还优化了 hashed alpha，在不同硬件上提升约 20–40%，低端硬件收益更大。([three.js forum](https://discourse.threejs.org/t/shade-webgpu-graphics/66969?page=6))

性能上可以理解成：

```txt
WebGLRenderer MSAA：
  单帧硬件采样，简单稳定

Shade TAA：
  多帧历史累积，pipeline 侵入性强，调试难
  但能同时处理几何边缘、纹理细节、SSR、阴影、透明/hashed alpha 等 temporal stability
```

也就是说：

```txt
便宜稳定：
  WebGL/WebGPU MSAA

高端综合画质：
  Shade TAA

但 Shade TAA 需要整条渲染管线配合，不是单独加一个 postprocess 就完事。
```

------

# 9. GI / SSR / 后处理性能

## WebGLRenderer

WebGLRenderer 当然也能做 SSAO、SSR、Bloom、FXAA、TAA、GI 近似，但一般是外接 pass：

```txt
EffectComposer
RenderPass
SSAOPass
SSRPass
UnrealBloomPass
TAAPass / SMAA / FXAA
```

性能问题是：

```txt
pass 多
render target 多
bandwidth 多
和材质/lighting 主 pipeline 耦合弱
很多信息要额外输出或重建
```

------

## WebGPURenderer

WebGPURenderer 更适合后续把 compute、postprocess、TSL 整合起来。
TSL 文档里也包含 viewport、depth、compute、postprocess 等节点能力，说明 three.js 的新 renderer 路线确实在往更统一的 GPU pipeline 走。([Three.js](https://threejs.org/docs/TSL.html))

但它仍然是 three.js 的通用 renderer，不是一个从第一天就围绕 deferred/TAA/GI/SSR 建的 renderer。

------

## Shade

Shade 的作者说得很直白：Shade 从一开始就是 deferred renderer，TAA 从一开始集成，indirect lighting 和 post-processing 也是引擎的重要部分。([three.js forum](https://discourse.threejs.org/t/shade-webgpu-graphics/66969?page=6))

这对性能的意义是：

```txt
G-buffer / visibility buffer / depth pyramid / motion vector / history buffer
这些不是“外挂 pass 临时拼出来的”
而是主管线的一部分
```

实际性能上，论坛里有人测一个 demo：RTX 4060、Windows 11、Chrome、1920x1080，GI off 约 80fps，GI on 约 40fps。这个不是严格 benchmark，但能说明 Shade 的 GI 是很重的 GPU 功能，开启后帧率可能接近腰斩。([three.js forum](https://discourse.threejs.org/t/shade-webgpu-graphics/66969?page=5))

所以结论是：

```txt
WebGLRenderer:
  后处理能做，但越堆越容易重

WebGPURenderer:
  更适合未来统一 compute/postprocess

Shade:
  高端效果集成最深，但 GPU 成本也最高
```

------

# 10. 动画 / skinning 性能

## WebGLRenderer / WebGPURenderer

three.js 常规 skinning 通常是：

```txt
CPU 更新 skeleton / animation mixer
GPU vertex shader 做 skinning
```

性能瓶颈可能是：

```txt
大量 AnimationMixer
大量 skeleton
大量 SkinnedMesh
CPU 更新骨骼层级
bounding volume 更新
draw call / material / shadow pass
```

WebGPURenderer 可以借 WebGPU/compute 有更多未来空间，但 three.js 默认应用层还是传统动画系统。

------

## Shade

Shade 后期开始做 GPU animation。作者说目标是不只是 skinning，而是 animation、bounding volume updates 等全部在 GPU 上跑；他列出当时 prototype 的数据包括 **786,655 total meshes** 和 **100 individual roots**，并说明 curves、tracks、clips、bindings、evaluation、local/global transforms、bounding volumes 都在 GPU 上。([three.js forum](https://discourse.threejs.org/t/shade-webgpu-graphics/66969?page=9))

然后他又补充 skinning 已经工作：324 个角色，每个都有自己的 skinning 信息和 timeline；后面还展示了 2,500 个角色。([three.js forum](https://discourse.threejs.org/t/shade-webgpu-graphics/66969?page=9))

这部分很能说明 Shade 和 three.js 的不同：

```txt
three.js:
  动画系统是引擎对象层功能，GPU 主要做 vertex skinning

Shade:
  动画状态、层级更新、bounding volume、skinning 都尝试 GPU-resident
```

对大量动态角色/实例，Shade 的路线性能上限更高。

------

# 11. 小场景性能：不要以为 Shade 一定赢

如果你的场景是：

```txt
几十个 mesh
几个材质
简单 PBR
少量灯光
没有复杂 GI
没有大量实例
没有大遮挡
只是产品展示/模型查看器
```

那么三者可能是：

```txt
WebGLRenderer：
  很成熟，很可能足够快

WebGPURenderer：
  可能接近或略好/略差，取决于浏览器、three 版本、shader、pipeline cache

Shade：
  visibility buffer、HZB、TAA、deferred、GI 这些固定成本可能反而显得重
```

Shade 的优势要在这些条件下才明显：

```txt
大量 mesh / instance
大量材质
复杂遮挡
复杂 postprocess
复杂 lighting
需要稳定 TAA/SSR/GI
需要超大场景 streaming
CPU draw call 成为瓶颈
```

所以你不能用一个小 demo 得出：

```txt
Shade 一定比 three.js 快
```

正确说法是：

```txt
Shade 的性能架构上限更高；
但固定成本和工程复杂度也更高。
```

------

# 12. 大场景性能：Shade 的优势会越来越明显

如果场景变成：

```txt
10 万个物体
100 万实例
几百材质
几百纹理
室内外复杂遮挡
大量动态灯光
SSR + TAA + GI + shadows + bloom
```

三者差异会拉开。

## WebGLRenderer

会被这些卡住：

```txt
CPU render list
draw call 数
WebGL state change
材质/纹理切换
shadow pass 重复 draw
后处理 pass bandwidth
```

## WebGPURenderer

会改善这些：

```txt
更现代 GPU backend
compute 支持
更好的 pipeline/resource abstraction
更适合未来高级特性
```

但仍然受限于：

```txt
Object3D scene graph
CPU render list
传统 per-object draw 思路
three.js 通用材质/资源抽象
```

## Shade

它正是为这种场景设计：

```txt
GPU culling
meshlet
visibility buffer
depth pyramid
material pass once per visible pixel
deferred shading
TAA/SSR/GI integrated
GPU animation
```

所以大场景性能排序大概是：

```txt
架构上限：
  Shade > WebGPURenderer > WebGLRenderer

工程可用性/成熟度：
  WebGLRenderer > WebGPURenderer > Shade

生态/兼容性：
  WebGLRenderer > WebGPURenderer > Shade
```

------

# 13. 性能瓶颈对照表

| 瓶颈类型            | WebGLRenderer             | WebGPURenderer                     | Shade                                             |
| ------------------- | ------------------------- | ---------------------------------- | ------------------------------------------------- |
| CPU scene traversal | 仍然明显                  | 仍然明显                           | 目标是大幅减少                                    |
| draw call 数        | 很敏感                    | 仍敏感，但 backend 更现代          | 几何阶段大幅压缩，material pass 按材质            |
| Object3D 数量       | 很敏感                    | 仍敏感                             | 更适合 GPU-side instance/scene table              |
| 材质数量            | 敏感                      | 敏感但可用新 binding/pipeline 管理 | 扩展性强，但 bandwidth 高                         |
| 纹理数量            | WebGL slot/state 限制明显 | 资源模型更好，但仍非 bindless      | 仍受 WebGPU 非 bindless 限制                      |
| overdraw            | 成本高                    | 成本高，除非特别处理               | visibility buffer 后 material shader 只跑可见像素 |
| occlusion culling   | 默认弱                    | 默认仍非核心能力                   | 核心能力之一                                      |
| postprocess         | 可做，但 pass 堆叠重      | 更适合整合 compute/postprocess     | 从架构上集成                                      |
| TAA                 | 外挂难做好                | 可做，但要管线配合                 | 核心特性                                          |
| GI                  | 通常外接/近似/昂贵        | 更有潜力                           | 深度集成，但成本高                                |
| 动画大量角色        | CPU 动画系统可能吃紧      | 有 compute 潜力                    | 目标是 GPU animation/skinning                     |
| bandwidth           | 中等                      | 中等到高                           | 高                                                |
| debug 难度          | 低到中                    | 中                                 | 高                                                |
| 性能上限            | 中                        | 中高                               | 高                                                |

------

# 14. 你可以这么判断该用哪个

## 用 WebGLRenderer，如果：

```txt
项目要稳定上线
兼容性最重要
场景规模中小
效果不是顶级 AAA
three.js 生态插件多
已有 WebGL 项目
团队不想承担 WebGPU 兼容风险
```

性能策略：

```txt
少 draw call
少 material
合并 geometry
InstancedMesh
LOD
控制 pixelRatio
控制 shadow map
少堆后处理
```

------

## 用 WebGPURenderer，如果：

```txt
想跟 three.js 新路线
想用 TSL / NodeMaterial
想用 WebGPU compute
浏览器环境可控
项目愿意承受新 renderer 的变化
希望未来迁移到 WebGPU
```

性能策略：

```txt
仍然要减少 Object3D / draw call
不要指望自动 GPU-driven
利用 compute 做适合 GPU 的任务
控制 pipeline/material permutation
关注 bind group / texture / buffer 更新成本
```

------

## Shade 这种架构适合，如果：

```txt
你要研究现代 renderer
你要大场景
你要百万实例
你要复杂遮挡
你要 TAA/SSR/GI/deferred 全套
你愿意牺牲 three.js 易用性
你愿意接受强约束的数据格式和管线
```

性能策略：

```txt
场景数据 GPU-resident
meshlet 化
visibility buffer
HZB occlusion
deferred material pass
GPU animation
控制 bandwidth
处理 WebGPU 无 bindless 的资源限制
```

------

# 15. 最核心结论

从**性能架构**看，三者不是简单的一条线：

```txt
WebGLRenderer < WebGPURenderer < Shade
```

而应该这样看：

```txt
WebGLRenderer：
  成熟的传统 renderer。
  小中型 three.js 项目性能很好，但大量 draw call / Object3D / 高端后处理会吃力。

WebGPURenderer：
  three.js 的新 renderer/backend。
  底层 API 和 shader/material 系统更现代，但 scene/render-list 仍是 three.js 传统架构。
  它不是自动 GPU-driven renderer。

Shade：
  从一开始就为 GPU-resident / GPU-driven / visibility-based deferred rendering 设计。
  大场景、多实例、多材质、复杂后处理和 GI 的性能上限最高。
  代价是高 bandwidth、高复杂度、弱生态、强约束。
```

一句话压缩：

**WebGLRenderer 的瓶颈主要是 WebGL 状态机 + CPU draw 提交；WebGPURenderer 改善了底层 GPU API 和 shader/backend，但保留了 three.js 的 CPU-driven 主架构；Shade 则直接把场景可见性、绘制调度、材质 shading、动画等大量工作搬到 GPU，因此大场景性能上限最高，但工程成本也最高。**