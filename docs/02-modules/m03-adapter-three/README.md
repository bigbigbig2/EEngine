# M03 · Adapter-Three（three.js 边界层）

## 1. 一句话职责

**唯一**允许依赖 three.js 的模块：把 `THREE.Scene` 编译/同步进 World，并执行材质/几何 **白名单**。

## 2. 为什么独立成模块

兼容性压力最大、变化最频繁。隔离后：内核永不被 three 类型污染；白名单升级只改本模块。

## 3. 拥有 / 不拥有

### 拥有

```txt
- ThreeSceneAdapter（全量 import / compile）
- ThreeSyncLayer（transform / material / geometry dirty）
- MaterialExtractor（MeshStandard 子集 → MaterialRecord）
- GeometryExtractor（BufferGeometry → 规范化属性描述）
- Texture 从 three Texture → 上传请求（实际上传可调 M01/M04）
- THREE.Object3D ↔ LiteHandle 映射表
- 不支持类型的错误/降级策略入口
```

### 不拥有

```txt
- 渲染主循环
- GPU culling / visibility
- 完整 TSL / NodeMaterial 编译器
- 复刻 WebGPURenderer
```

## 4. 依赖

| 方向 | 模块 |
|------|------|
| 依赖 | **three（peer）**、M02 World、M01（上传资源时） |
| 被依赖 | 应用层；**其他 packages 不应再依赖 three** |

## 5. 对外概念接口

```txt
importThreeScene(world, scene, options) → ImportResult
compile(world, scene, camera)           // 应用友好封装
track(object3D) → LiteHandle
markTransformDirty / markMaterialDirty / markGeometryDirty
sync(world) → SyncStats
```

## 6. 计划中的子文档

| 文件 | 用途 | 状态 |
|------|------|------|
| `whitelist.md` | 材质/几何/灯光白名单 | 未写 |
| `import-pipeline.md` | import 步骤 | 未写 |
| `sync-rules.md` | 何种修改触发何种 dirty | 未写 |
| `reuse-from-three.md` | 复用 math/loader 边界 | 未写 |
| `interface.md` | 对外 API | 未写 |

## 7. 关联

- 原则：P1 three 是输入不是内核  
- 母本：设计 v2 §2、§4  
- 兼容总册（后写）：`05-compatibility/`  
