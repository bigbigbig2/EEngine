# M03 · Adapter-Three — 设计意图

> 母本：设计 v2 §2、§4；docs/source/comparison-three-vs-shade.md（输入 ≠ 内核）；P1

## 1. 在工程等式中的位置

```txt
three.js 生态输入层  ← 本模块是其工程载体
Lite Runtime
Shade-like Renderer
```

## 2. 要完成的转换

```txt
THREE.Scene / Mesh / Material / Texture / Camera / Light
        ↓  import / track / sync
World plain data + ids
        ↓
（再经 M04）GPU-resident tables
```

## 3. 允许的「重」与禁止的「重」

允许（导入期）：

```txt
整树 traverse 一次做 compile
提取 geometry、bake 选项（静态、meshlet 等）
白名单校验与 ImportResult
```

禁止（帧主路径）：

```txt
每帧 full traverse 构建 render list
每帧把 three 对象图当作绘制调度核心
```

## 4. 同步模型（设计 v2 §4.3）

```txt
静态：compile 一次
动态：dirty 标记 → 增量 sync
  transform / material / geometry / texture 分类更新
```

## 5. 与「尽量用原来的」对齐

```txt
用：loader、math、材质参数语义、glTF 约定
不用：WebGPURenderer、RenderLists、TSL 全核
```

见 `05-compatibility/`。

## 6. 不做的承诺

```txt
完整 ShaderMaterial 宇宙
与 three 像素级一致
第一阶段全 glTF 扩展
```
