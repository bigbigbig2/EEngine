# G-Buffer 布局意图

> 母本：设计 v2 §10.4；对比 bandwidth；webgpu-browser-limits DPR

## 1. 角色

```txt
Material Resolve 的输出
Lighting / AO / SSR / GI / TAA 的输入
不是 visibility identity（那是 VB）
```

## 2. 推荐成员集合（母本初始）

| 目标 | 意图内容 | 谁读 |
|------|----------|------|
| **gAlbedo** | 基色（+ 可含 alpha 类信息） | Lighting、合成 |
| **gNormal** | 世界或视图法线 | 光、SSR、AO、GI |
| **gMaterial** | roughness / metallic / ao 等打包 | 光、SSR |
| **gMotion** | 屏幕运动向量 | TAA、SSR、部分 denoise |
| **gEmissive** | 自发光 | 合成 |
| **depth** | 硬件深度 | 全局 |

格式母本建议（设计层保留选项，不锁死实现）：

```txt
gAlbedo:   rgba8unorm 或 rgba16float
gNormal:   rgba16float 或 rgb10a2 / 编码
gMaterial: rgba8unorm 或 rgba16float
gMotion:   rg16float
gEmissive: rgba16float
depth:     depth32float
```

## 3. 分档（母本 High / Balanced / Low 精神）

```txt
High：更高精度附件
Balanced：8bit albedo/material + 压缩 normal
Low：半分辨率后续效果、更激进打包、可无独立 emissive
```

与 **DPR / internal scale** 联动：附件分辨率跟内部分辨率，不是 CSS 像素裸乘无限 DPR。

## 4. 空间约定（必须文档化一种）

```txt
Normal：world 或 view，全项目统一
Motion：UV 空间位移或像素空间，全项目统一
深度：非反向/反向 Z，全项目统一
```

未统一会导致 SSR/TAA 全面错误。

## 5. 与 VB 的关系

```txt
VB 像素 → Resolve → 写 GBuffer 同一像素
Lighting 不再需要 mesh id（除非调试）
```

## 6. 带宽意识

```txt
附件多 × 高分辨率 = 母本与对比中的高 bandwidth 主因之一
半分辨率 SSR/GI 写在独立目标，不强迫全分辨率 GBuffer 加倍
```
