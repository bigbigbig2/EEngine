# Stage 3：Local Probe、SSSR 与 TAA/TAAU 时域重构

> 状态：待执行。
> 
> 目的：在完整 opaque HDR 和独立 AO 之后，重写反射校正与最终时域重建，解决抖动、拖影、断裂和错误 history。

## 1. 反射产品

```text
OpaqueLightingFrame.iblSpecular
  + Local Reflection Probe
  + SSSR hit/confidence/variance
  → ReflectionFrame
  → finalSpecular = mix(IBL, resolved, confidence)
  → correction = finalSpecular - IBL
  → CompleteOpaqueHDR
```

SSR 是 specular correction，不拥有完整间接光，也不能 miss 时写黑色覆盖。粗糙度、越界、厚度和距离都必须产生连续 confidence。

## 2. SSSR 算法合同

- 输入：完整 opaque HDR、reverse-Z depth/HZB、normal、roughness、velocity、物理尺度和 probe baseline。
- HZB traversal 明确 ray origin、ray cone、thickness、max distance、hit UV 和 edge fade；max distance 必须参与 traversal termination，而不是只在完成后拒绝。
- hit UV 才能用于 edge fade；thickness 使用 physical-scale/ray-cone 语义，禁止固定经验常数覆盖整个场景。
- 输出 resolved specular、confidence、variance；half-resolution 时显式声明 domain conversion。
- 参考 FidelityFX SSSR 的 classification/traversal/denoise 思路，但重新设计 WebGPU ABI，不引入不可用的 native capability。

## 3. Temporal/TAAU 算法合同

- `OpaqueTemporalValidity` 与 `FinalTemporalValidity` 分层；AO/SSR 可有独立 history，最终 TAA/TAAU 不能掩盖上游错误。
- velocity 已包含 current/previous jittered projection delta，resolve 不二次补偿 jitter。
- history rejection 使用 motion bounds、linear-depth consistency、normal/surface identity、reactive 和 camera cut/resize/DRS revision。
- TAA resolve 固定 history color space、pre-exposure 语义、YCoCg/neighborhood clamp、closest-depth velocity 和 Catmull-Rom 重建；所有参数必须有真实 shader consumer。
- TAAU 输出 `output-full`，internal→output 的重采样、history invalidation 和 sharpening 输入 domain 必须显式声明。
- DRS 只使用 GPU timestamp 的延迟反馈和固定 bucket，不使用 CPU frame-time governor。

## 4. 实施顺序

1. 先让 Local Probe 与 IBL baseline 进入 `ReflectionFrame`。
2. 替换 SSSR traversal、confidence、denoise 和 temporal history；对照现有 SSR 做 paired A/B/C。
3. 统一 validity/rejection reason 与 debug counters，删除 AO/SSR 各自重复的隐式判断。
4. 替换 TAA/TAAU resolve 和 history commit；先锁定静态细节，再验证快速运动、镜面高光、透明 reactive 和 DRS 切换。
5. 删除旧 SSR correction、旧 Temporal classification/resolve consumer，确保只有一条生产路径。

## 5. 退出条件

- 反射 miss/roughness/越界连续回退到 probe/IBL；
- SSSR 不再读取不完整 scene radiance；
- 静态相机无抖动，运动序列无明显拖影和错误残影；
- resize、camera cut、exposure、DRS bucket 变化正确清理 history；
- TAAU 的 internal/output domain、GPU 时间、显存和 feature-off 有证据；
- 被替代的 SSR/TAA 旧 consumer 已删除。

