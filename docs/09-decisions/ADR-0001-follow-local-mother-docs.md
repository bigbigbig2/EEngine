# ADR-0001 · 以本地母本为产品权威

- **状态：** Accepted  
- **日期：** 2026-07-17  
- **更新：** 2026-07-17 — 母本迁入 `docs/source/` 并统一英文文件名  
- **影响模块：** 全部文档与未来代码边界  

## 背景

仓库同时存在研究长文、完整设计 v2、对比/局限、以及 docs 分册。若 docs 自行「收窄目标」，会与用户本地文档方向偏离。

## 决策

```txt
1. 产品公式与能力全集以
   docs/source/design-v2-full.md 为准
2. 架构判断以
   docs/source/comparison-three-vs-shade.md 为准
3. 运行外壳以
   docs/source/webgpu-browser-limits.md 为准
4. Layer 3 上限参照
   docs/source/shade-reference-v3.md
5. WebGPU 基础以
   docs/source/webgpu-fundamentals.md 为准
6. verification 草案
   docs/source/modules-phases-verification.md
   服从以上，不得反向删目标
7. docs/00–09 只做结构化展开；冲突改分册
```

旧根目录文件名对照见 [../source/README.md](../source/README.md)。

## 后果

### 正面

```txt
方向不漂移
分册可并行写
实现分期不等于改产品身份
母本集中在 source/，根目录干净
```

### 负面 / 风险

```txt
文档体量大
分期落地时需反复强调「未做 ≠ 不做」
```
