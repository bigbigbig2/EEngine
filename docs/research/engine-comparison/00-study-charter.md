# 研究章程

## 1. 核心问题

这项研究要回答的不是“WebGPU 是否比 WebGL 快”，而是：

1. 两个引擎分别由谁拥有场景、可见性、绘制任务和 GPU 资源？
2. 一帧中，CPU 与 GPU 各自负责哪些决策？
3. 面对大量实例、材质和几何体时，两边的工作量如何增长？
4. 两边如何表达渲染流程、资源依赖和扩展点？
5. GPU-driven 路线得到什么，同时付出哪些复杂度、兼容性和调试成本？
6. 哪些设计可以迁移到 OEngine，哪些设计依赖各自的产品定位而不应照搬？

## 2. 对比对象

three.js 侧同时观察三个层次：

- 公共场景与资源模型：`Scene`、`Object3D`、`Mesh`、`Material`、`BufferGeometry`。
- common renderer：后端无关的渲染组织、render list、render object、binding、pipeline。
- WebGPU backend：WebGPU 设备、资源、管线和命令编码实现。

reconstructed 侧重点观察：

- 公共场景与资源模型。
- `Renderer` 与 `FrameGraph` 的帧调度。
- GPU scene、数据库、分配器和常驻资源。
- instance / meshlet culling、工作生成、visibility / material resolve 和后处理 pass。

## 3. 不做什么

- 不用功能数量直接推导架构质量。
- 不把类名相似视为模块职责相同。
- 不用单一 demo 的 FPS 代替架构分析。
- 不预设 GPU-driven 在所有场景都更快。
- 不把 reconstructed 的现状自动当作 OEngine 的最终目标实现。

## 4. 分析单位

每个专题优先沿着一个完整用例分析，而不是孤立阅读文件：

```txt
调用者意图
  → 公共 interface
  → CPU 数据变更
  → CPU/GPU 同步
  → 调度与依赖
  → 可见性和工作生成
  → shading / post
  → present 与统计
```

首批用例：

1. 初始化设备并渲染第一帧。
2. 新增一个静态 mesh。
3. 更新一个实例的 transform。
4. 切换材质或纹理。
5. 相机移动后重新计算可见性。
6. 窗口 resize、device lost 和资源释放。

## 5. 模块分析语言

每次比较都回答：

- **Module**：承担这一能力的模块是什么？
- **Interface**：调用者必须知道哪些规则才能正确使用它？
- **Seam**：行为可替换或职责交接的位置在哪里？
- **Adapter**：哪一个实现位于该 seam？
- **Depth**：模块隐藏了多少复杂度，调用者获得多少 leverage？
- **Locality**：修改、调试和验证是否集中在一个地方？

尤其要区分：抽象层是否真的存在多个 adapter，还是只有为未来变化预留的假设性 seam。

## 6. 证据优先级

从强到弱：

1. 可重复的测试、捕获、profile 或最小实验。
2. 实际执行路径及其源码调用链。
3. 类型、字段和静态依赖关系。
4. 注释、README 与命名。
5. 研究者的类比和直觉。

关键性能判断至少需要第 1 或第 2 级证据。

## 7. 单篇专题的完成标准

- 标明对应版本或 commit。
- 同时给出两边的源码证据。
- 区分事实、推断和假设。
- 画出或写清数据流与控制流。
- 记录收益、代价和适用场景。
- 给出对 OEngine 的启发，但不直接把启发写成既定决策。

