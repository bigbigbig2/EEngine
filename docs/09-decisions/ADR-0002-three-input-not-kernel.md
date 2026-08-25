# ADR-0002 · three 为输入层，不为渲染内核

- **状态：** Accepted  
- **日期：** 2026-07-17  
- **影响模块：** M03、M02、M04、全部 render 模块  

## 背景

docs/source/comparison-three-vs-shade.md：WebGPURenderer 仍是 CPU-driven scene/render-list。设计 v2 明确不要 fork、不要以 WebGPURenderer 为核。

## 决策

```txt
1. 唯一官方 three 依赖边界：Adapter（M03）
2. Layer 3 禁止以 Object3D 遍历为每帧主路径
3. 复用 loader / math / 材质语义；不复用 RenderLists / WebGPURenderer 内核
4. 兼容政策：input 兼容，internals 不兼容
```

## 后果

```txt
+ 架构上限可对齐 Shade 方向
+ 用户仍可用 three 搭场景
− 不能承诺与 three 渲染行为像素级一致
− 自定义 ShaderMaterial 等需明确非优先
```
