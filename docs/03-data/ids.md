# ID 系统（设计语义）

> 母本：设计 v2 §6.2  
> 关联：`records-fields.md`、`ownership-and-lifetime.md`、M02 / M03 / M04

## 1. 类型族

逻辑上必须区分（禁止混用同一裸 number 当「万能 id」）：

```txt
InstanceId     场景中可绘制实体行
MeshId         几何资源（可被多 instance 共享）
MeshletId      cluster（或「mesh 内 meshlet 下标 + meshId」的逻辑定位）
MaterialId     材质行
TextureId      纹理逻辑 id（≠ bindless 硬件下标）
TransformId    变换行
BoundsId       包围行
LightId        灯行
SamplerId      采样器（若与纹理分离）
```

GPU 侧一律 **u32**。  
CPU 侧建议 branded type（母本 TypeScript 方向），防止 `meshId` 传进 `materialId` 槽。

## 2. 保留值

```txt
0 = invalid / null / 「无此资源」
1 .. N = 有效
```

用途：

```txt
textureId == 0     → 不采样，用 factor
可选引用 == 0      → 无 parent / 无 shadow map 等
debug 清零缓冲     → 0 表示「无几何命中」
```

**分配器不得把 0 发给有效对象。**

## 3. 稳定性

```txt
同一 authoring 对象在未销毁前：id 稳定
便于：
  dirty 按行上传
  LiteHandle 持久
  调试与抓帧对比
```

销毁后：

```txt
id 可进 freeList 复用
须防 ABA：读写方看到「旧 id 新对象」
  设计允许 generation（句柄 = id + generation）
  或「销毁后 id 冷一段时间」
  具体机制实现定，设计要求：有策略且可测
```

## 4. 谁分配 / 谁禁止分配

| 角色 | 权限 |
|------|------|
| **M02 World** | 唯一逻辑 id 分配与回收 |
| **M03 Adapter** | 申请 id、建立 three↔id 映射 |
| **M04 GPU Scene** | **禁止**第二套 id 空间；只镜像行 |
| **M08–M13** | 只消费 u32 id |

## 5. LiteHandle（Adapter 侧）

```txt
面向应用/同步层的句柄，不是 GPU 行号本身的别名宣传

一个 Object3D 可能对应：
  1 个 InstanceId
  + 共享的 MeshId / MaterialId
  + TransformId / BoundsId

一个 Material 可能被多 instance 共享同一 MaterialId
一个 Geometry 同理 MeshId
```

映射表：

```txt
只活在 M03（及调试工具）
不进入 Layer 3 shader 主路径
```

## 6. 共享与去重意图

```txt
import 时：
  相同 three.Material 引用 → 宜同一 MaterialId
  相同 BufferGeometry 引用 → 宜同一 MeshId
  相同 Texture 引用 → 宜同一 TextureId

InstancedMesh：
  多 Instance 行 + 共享 Mesh/Material
  或专用 instance 缓冲策略（后定），语义上仍是多实例
```

## 7. MeshletId 的两种理解（设计允许）

```txt
A. 全局 MeshletId（MeshletTable 稠密下标）
B. (meshId, localMeshletIndex) 打包/双字段

母本 Mesh 含 meshletOffset/Count → B 很自然
全局 id 便于某些 list 存单 u32
选定一种为主，另一种可派生；禁止两套真源
```

## 8. TextureId ≠ 采样下标

```txt
TextureId 是逻辑资源
真正采样依赖 TextureRegistry：
  arrayLayer / atlasRect / bind-group batch
见 records-fields 与 06-constraints/texture-and-bindless
```

## 9. 调试约定

```txt
Stats/Debug 打印应带类型名：material#3 而非裸 3
无效引用统一显示为 null/0
VB debug 伪彩由 id 哈希上色时，0 保持可识别背景
```

## 10. 版本与序列化（预留）

```txt
若未来自定义场景格式（Shade 方向）：
  文件内 id 可重编
  加载时重映射到运行时 id
  不要求与某次运行的 u32 数值跨进程稳定
```
