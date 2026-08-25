# M11 · Material Resolve — 设计意图

> 母本：设计 v2 §10；Shade v3 §9；docs/source/comparison-three-vs-shade.md material/overdraw

## 1. 意图

```txt
读 visibility id
重建属性（如重心坐标路径）
执行材质，写 G-buffer 或等价
目标：昂贵材质逻辑面向最终可见像素
```

## 2. 组织方式（Shade 案例精神）

```txt
可按 material 分发（draw 与材质数相关，而非 mesh 数）
纹理切换与绑定策略受无 bindless 约束
```

## 3. 与 three PBR

```txt
参数语义对齐 MeshStandard 等（设计 v2）
实现落在 WGSL/表，不经 WebGPURenderer 内核
```

## 4. 扩展性

对比/Shade：材质数量扩展性好，带宽高——设计需同时写清利弊。
