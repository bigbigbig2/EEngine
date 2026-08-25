# M12 · Lighting 设计意图

> 母本：设计 v2 §11、§16；Shade 光影；对比高端集成

## 1. 路径

```txt
早期：Baseline 内嵌简单光 + IBL
成熟：DeferredLighting 读 GBuffer
扩展：Shadow、多光 clustered、GI 接口
```

## 2. 输入

```txt
GBuffer 或 baseline 中间属性
LightTable
IBL / env
Shadow 资源（阶段后）
AO/GI 调制（可选）
```

## 3. 输出

```txt
HDR 光照色（进 TAA/SSR/Bloom 前）
```

## 4. 阴影意图（Phase 9）

```txt
CSM 方向
contact shadow 方向
与可见性/cull 复用思想（少重复画全世界）
可关、可降级
```

## 5. GI 意图（Phase 10）

```txt
探针 / bake / SVLM 等为母本与 Shade 方向
本模块提供「间接光采样接入 Lighting 或复合 pass」的位置
具体算法可演进，目标身份保留
```

## 6. 与 three 灯

```txt
Adapter 映射常用 Light → LightTable
不在 shader 里遍历 three 场景图找灯
```
