# 端到端故事（设计叙事）

> 用一条故事串起本地母本，不引入新目标

## 1. 用户侧

```txt
用 three 建 Scene、GLTFLoader 加载、MeshStandardMaterial 调参
与现在用 three 的手感一致（输入层）
```

## 2. 编译一刻

```txt
Adapter 遍历一次 → World 表 → GPU Scene resident
不在此后把 Object3D 树当每帧渲染调度器
```

## 3. 每一帧

```txt
脏同步（少）
→ GPU cull（少画看不见的）
→（meshlet）细粒度
→ visibility 只记看见谁
→ resolve 只给可见像素做材质
→ lighting / 阴影
→ TAA 稳定时间域
→ SSR/GI/Bloom 等按档
→ 输出到 canvas
```

## 4. 为何值得（docs/source/comparison-three-vs-shade.md）

```txt
大场景、多实例、多材质、遮挡、集成后处理时
CPU render-list 与 overdraw 账本被改写
```

## 5. 为何仍克制（docs/source/webgpu-browser-limits.md）

```txt
标签页可回收、可节流、要加载解码、要管 DPR 与预期
强的是内部管线；外壳仍是网页
```

## 6. 建设顺序（设计 v2 Phase）

```txt
先壳 → 能导入画对 → 表驱动 → frustum
→ meshlet/VB/resolve → HZB
→ TAA → SSR/阴影 → GI → 动画
```

分期是顺序，不是改故事结局（ADR-0003）。
