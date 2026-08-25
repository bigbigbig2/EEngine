# Dirty 模型（设计语义）

> 设计 v2 §4.3、§6；verification 禁止每帧 full rebuild

## 1. Dirty 种类

| Kind | 触发例 | 后果意图 |
|------|--------|----------|
| Transform | 物体移动/旋转 | 上传 Transform 行；更新 world bounds |
| Material | 改 metalness/贴图引用 | 上传 Material 行；可能失效 pipeline/bind 键 |
| Geometry | 改 attribute/index | 重传 Mesh 缓冲；可能重建 meshlet |
| Texture | 换图/改内容 | 重传图像或改 TextureRecord |
| Light | 改灯参数 | 上传 Light 行 |
| Instance structural | 增删 instance | 改 Instance 表 + freeList |
| Full scene | 首次 compile / 大破坏性变更 | 允许 full upload |

## 2. Range 合并意图

```txt
连续 dirty 行合并为 range
range 过多 → 退化为 full upload（预算策略）
每帧 upload budget（设计 v2 意识）：防止单帧尖刺
```

## 3. 谁标记

```txt
用户改 three 对象 → Adapter mark*Dirty
业务直接改 World API → World markDirty
渲染核只读 dirty 结果，不扫描 Object3D
```

## 4. 与静态场景

```txt
staticScene 编译选项：bake 后可关闭大部分 per-frame sync
仅相机与全局常量每帧变
```

## 5. 反模式

```txt
❌ 每帧 traverse 全场景当 dirty 发现机制
❌ 任何小改动 full 重建全部 GPU buffer
❌ Layer 3 自己「猜」three 是否变了
```
