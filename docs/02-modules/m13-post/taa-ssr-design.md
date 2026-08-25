# M13 · TAA / SSR 设计意图

> 母本：设计 v2 §13–14；Shade §12、§14；对比 §8–9

## 1. TAA 在母本中的身份

```txt
不是可选美化滤镜
是 deferred/现代栈的抗锯齿与时间稳定中枢
SSR/AO/GI 噪声与闪烁依赖它
```

## 2. TAA 数据依赖（契约）

```txt
必须：
  当前帧色
  history 色
  motion（物体 prevWorld + 相机 prevVP）
  depth（rejection / disocclusion）
  jitter 相位

强烈相关：
  材质采样去抖（UV 去 jitter）
  mip bias（Shade 防糊）
```

## 3. 失败与降级

```txt
无 motion → 仅相机或关 TAA
history 无效（M14）→ 重置 accum
剧烈 disocclusion → clamp/reject，允许短伪影，禁止永久拖影污染
```

## 4. SSR 意图

```txt
母本难点不只 ray march：
  hit resolve、mip 色、reprojection、denoise、能量、roughness
与 TAA：时间域共用 history 哲学
分档：半分辨率、可关（局限 + 产品预期）
```

## 5. 与 FrameGraph

```txt
TAA/SSR 为独立 task，但资源与 jitter 由全局 Frame 约定
Bloom 等可与 SSR 临时 RT 别名（Shade）
```

## 6. 阶段

```txt
Phase 8：TAA 最小可用
Phase 9：SSR 集成
更早可有无 TAA 的 HDR 输出，但不得声称时间稳定栈完成
```
