# M01 · Engine（WebGPU 引擎核）

## 1. 一句话职责

管理 **WebGPU Device / Canvas / 资源与管线缓存**，作为所有 GPU 操作的唯一入口。

## 2. 为什么独立成模块

设备生命周期、pipeline 缓存、buffer/texture 池是横切基础设施；与「场景语义」解耦后，World / Render 都能变薄。

## 3. 拥有 / 不拥有

### 拥有

```txt
- requestAdapter / requestDevice
- canvas context configure
- GPUBuffer / GPUTexture 分配与回收（ResourcePool）
- ShaderModule / RenderPipeline / ComputePipeline 缓存
- BindGroup 缓存策略（键的定义可与使用者协作）
- Queue submit 的底层封装（可选）
- device.lost 的底层事件出口
```

### 不拥有

```txt
- THREE.Scene / Material 语义（→ M03）
- Instance / Mesh 表含义（→ M02 / M04）
- Cull / Draw 算法（→ M08+）
- 帧图业务 pass 注册表的「渲染语义」（→ M05 描述 pass，M01 只提供执行手段）
```

## 4. 依赖

| 方向 | 模块 |
|------|------|
| 依赖 | 浏览器 WebGPU；M00 工程 |
| 被依赖 | M02（可选持有引用）、M04–M15 几乎全部 |

## 5. 对外概念接口

```txt
createEngine(options) → EngineContext
destroyEngine(engine)
engine.device / engine.queue / engine.context
createBuffer / createTexture / destroy*
getOrCreatePipeline(key)
getOrCreateBindGroup(key)
onDeviceLost(handler)
```

## 6. 计划中的子文档

| 文件 | 用途 | 状态 |
|------|------|------|
| `interface.md` | EngineContext 字段与工厂函数 | 未写 |
| `resource-pool.md` | 分配/别名/销毁规则 | 未写 |
| `pipeline-cache.md` | pipeline key 设计 | 未写 |
| `limits-features.md` | 需要的 limits/features | 未写 |

## 7. 关联

- 原则：P0 WebGPU-only  
- 母本：设计 v2 §19 Engine Layer  
