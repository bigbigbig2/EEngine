# 兼容策略（设计层）

> 依据：设计 v2 §1.3、§4、§24.6、§25；P1 原则

## 1. 总政策

```txt
three.js-compatible input
not three.js-compatible internals
```

两句话：

```txt
1. 能用 three 的加载器、场景图、材质参数来「喂」引擎
2. 引擎内部不为了兼容而保留 render-list 架构
```

## 2. 兼容的层次

| 层次 | 态度 |
|------|------|
| 文件与加载 | 积极（glTF 等，子集可成长） |
| 场景图 authoring | 积极作为输入 |
| MeshStandard 类 PBR 参数 | 积极（母本：opaque PBR first） |
| 变换与相机 | 积极 |
| 灯光（常用类型） | 积极但可简化映射到 LightTable |
| 完整材质宇宙 | 不承诺第一阶段 |
| ShaderMaterial / 自定义 GLSL 钩子 | 非目标优先 |
| TSL 图完整兼容 | 非内核路径 |
| 与 WebGPURenderer 像素级一致 | 非目标 |

## 3. 静态优先、动态第二（P7）

```txt
静态大场景：主战场（archviz / 城市 / 多实例）
动态：transform 增量、后续动画/skinning（设计 v2 与 Shade 路线均包含方向）
几何拓扑每帧乱改：不作为第一阶段友好路径
```

## 4. 失败与降级（设计意图）

当输入超出当前支持面：

```txt
明确失败或降级（unlit / 占位 / 跳过）
禁止静默「看起来能跑但数据错了」
unsupported 应可被工具/导入结果观察到
```

（具体名单随实现迭代；政策层先固定「要可观测」。）

## 5. 与docs/source/comparison-three-vs-shade.md 的关系

```txt
兼容 three 输入 ≠ 性能变成 WebGPURenderer
性能故事仍按 GPU-resident 架构讲
```
