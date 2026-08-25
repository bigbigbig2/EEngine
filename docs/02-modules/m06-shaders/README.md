# M06 · Shaders（着色器组织）

## 1. 一句话职责

管理 **WGSL 源码、fragment 组合、变体 key、与 pipeline 的衔接**；不负责业务 pass 调度。

## 2. 为什么独立成模块

不用完整 TSL，但仍需要可组合、可缓存、可变体的 shader 体系；与 Engine 的 pipeline cache 分离：本模块管「源与 ABI」，Engine 管「GPU 对象」。

## 3. 拥有 / 不拥有

### 拥有

```txt
- WGSL 文件布局约定
- ShaderFragment 组合规则（参考 Babylon Lite 思路）
- 稳定 bind group ABI 约定（与 03-data / G 附录对齐）
- variant / defines / flags → shader key
- PBR 等公共函数库（wgsl include 或拼接）
```

### 不拥有

```txt
- NodeMaterial / TSL 运行时图
- 每材质一份完全动态生成的任意用户 GLSL
- pass 谁先谁后（→ M05）
```

## 4. 依赖

| 方向 | 模块 |
|------|------|
| 依赖 | M01（createShaderModule） |
| 被依赖 | M09、M10、M11、M12、M13、M08 |

## 5. 对外概念接口

```txt
getShader(name, variantKey) → GPUShaderModule | source
composeFragments(fragments) → string
materialFlagsToKey(flags) → VariantKey
// bind group 槽位文档化常量
```

## 6. 计划中的子文档

| 文件 | 用途 | 状态 |
|------|------|------|
| `organization.md` | 目录与命名 | 未写 |
| `fragment-model.md` | 组合模型 | 未写 |
| `bind-group-abi.md` | 槽位 ABI | 未写 |
| `variants.md` | 变体策略 | 未写 |
| `pbr-lib.md` | PBR 函数清单 | 未写 |

## 7. 关联

- 原则：P0、不用完整 TSL  
- 母本：设计 v2 §18 Shader System  
