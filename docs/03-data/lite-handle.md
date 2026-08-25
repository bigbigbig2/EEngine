# LiteHandle 与 three 映射

> 母本：设计 v2 §4 Adapter / Sync；P1

## 1. 为什么需要 Handle

```txt
用户握着 THREE.Object3D
引擎握着 InstanceId / TransformId
中间需要稳定桥梁，否则：
  无法 markTransformDirty(object)
  无法只更新一行表
```

## 2. 映射方向

```txt
three 对象  →  LiteHandle  →  一组 typed ids
ids         →  不强制可反查 three（Layer 3 不需要）
调试工具可维护弱反查
```

## 3. Handle 内应能回答的问题

```txt
这个 object 对应哪个 InstanceId？（若有）
transform / bounds / mesh / material 各是哪个 id？
是否 static？是否参与阴影？
上次 sync 的版本号？
```

## 4. 生命周期

```txt
track(object) / import 时建立
object 从场景移除或 dispose：
  释放 instance 行
  若 mesh/material 引用计数归零 → 可释放资源 id
页面 device lost：
  GPU 资源重建，id 空间策略二选一：
    保留 CPU id，重 upload
    或全量 re-import（须文档化）
  推荐：保留 CPU id 与 Handle，只重建 GPU
```

## 5. 不进入的地方

```txt
WGSL 不接收 LiteHandle
Render pass 不遍历 Handle 表建 draw list
Handle 表不是 render-list 换皮
```
