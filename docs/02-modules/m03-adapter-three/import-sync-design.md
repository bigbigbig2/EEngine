# M03 · Import / Sync 设计

> 母本：设计 v2 §4；P1；docs/05

## 1. Import（compile）流水线意图

```txt
1. traverse Scene（仅此低频全量）
2. 收集 Mesh / InstancedMesh（白名单内）
3. 提取 BufferGeometry → 规范化属性
4. 提取 Material 参数 → MaterialRecord
5. 纹理 → TextureRecord + 上传请求
6. 分配 ids，填 World stores
7. 可选：meshlet bake、合并策略
8. 首次 upload → GPU Scene
9. ImportResult：计数 + unsupported 列表
```

## 2. Sync 流水线意图

```txt
每帧：
  消费 mark*Dirty
  分类更新 Transform / Material / …
  禁止：无 dirty 信息时 full traverse 建 draw list
```

## 3. 静态选项意图

```txt
staticScene / bakeTransforms：
  减少运行时 sync
  适合 archviz 主场景
```

## 4. 与 three 控件

```txt
OrbitControls 等可继续用 three 改 Camera
相机每帧写入 Frame 常量即可
不必把 Controls 重写进内核
```

## 5. 错误策略

```txt
超白名单：记录 + 降级/跳过
不假装与 WebGPURenderer 行为一致
```
