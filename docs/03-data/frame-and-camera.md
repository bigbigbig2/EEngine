# Frame / Camera 常量（设计语义）

> 母本：设计 v2 §6 相机相关、附录 G.1、TAA §13  
> 非「表行」，但是每帧数据面的一部分

## 1. 为何单独成文

```txt
表：场景实体
Frame/Camera：观察者与帧全局
cull / VB / resolve / TAA / SSR 都读它们
```

## 2. CameraUniform 意图字段

| 意图 | 用途 |
|------|------|
| view / proj / viewProj | 变换 |
| invView / invProj / invViewProj | 反投影重建世界位置 |
| prevViewProj | 相机运动向量、TAA/SSR reprojection |
| position / direction | 光照、雾、LOD |
| near / far / z 参数 | 深度线性化、HZB |
| viewport size / inv size | 像素↔UV |
| jitter / prevJitter | TAA 子像素 |
| layer mask | 与 instance.layerMask |

来源：

```txt
three.Camera → Adapter 或每帧抽取
不必把 Camera 做成 Instance 表一行（可用独立 uniform）
```

## 3. FrameUniform 意图字段

| 意图 | 用途 |
|------|------|
| frameIndex | 蓝噪、TAA 相位、调试 |
| time / delta | 动画、效应 |
| render size / internal scale | 动态分辨率 |
| exposure / 全局色调参数 | tonemap 前 |
| feature bits | 本帧开了哪些 pass |
| upload 统计指针（可选） | 调试 |

## 4. 与 Transform.prev 的分工

```txt
相机运动：Camera.prevViewProj
物体运动：Transform.prevWorld
两者合成像素 motion（TAA/SSR）
缺一则 motion 不完整 → 时间域必须降级
```

## 5. Jitter 契约（TAA）

```txt
开启 TAA 时：
  投影矩阵带 jitter
  材质采样路径知道如何去抖（Shade）
关闭 TAA：
  jitter = 0
  history 不更新或停用
```

## 6. 更新频率

```txt
每帧通常更新 Camera + Frame
表数据仅 dirty 时更新
禁止把整个场景矩阵塞进巨型 uniform 代替表
```

## 7. Bind 位置意图

母本附录 G：

```txt
Group 0 ≈ Frame + Camera + 公共 sampler
与「场景表 Group」「几何 Group」「pass 资源 Group」分离
```

详见 `bind-group-layout.md`。
