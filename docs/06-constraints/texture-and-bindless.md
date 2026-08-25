# 纹理与 Bindless 缺失（设计约束）

> Shade v3 §20；对比 §7；设计 v2 §12 / 风险 24.1

## 1. 事实

```txt
WebGPU 当前路径不能按原生 bindless 引擎假设
texture array 层数等有上限
大 archviz（海量 unique 贴图）会撞墙
```

## 2. 设计后果

```txt
TextureId 不能天真映射为「无限独立 view 随手绑」
需要策略族：
  - 数量预算与导入失败
  - array / atlas 打包
  - 材质合并压力
  - 长期 virtual texture 方向（母本/H 附录级）
```

## 3. 与模块

```txt
政策与预算：兼容层 + 产品分档
布局与上传：M04 / 纹理系统
采样：M06 / M11
```

## 4. 与路线图

```txt
Phase 1–2 就必须有「上限意识」
不能等到 Phase 6 resolve 才第一次发现绑不动
```
