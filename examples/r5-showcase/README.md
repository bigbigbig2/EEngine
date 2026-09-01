# R5 综合场景

独立交互示例，使用 OEngine production `Renderer` 加载本地 `Flower.glb`，经过
`load_gltf_packed → Geometry Cooker → Packed Scene → Hardware Visibility → Single Material Resolve`
主链，组合展示当前已经接入的 Clustered Lighting、IBL、Packed CSM、Packed Transparency、
GTAO、SSR 与 TAA/TAAU。

页面保留 feature toggle、internal-resolution scale 和 production Debug View。相机控制使用
OEngine `OrbitalCameraController`：左键旋转、右键平移、滚轮缩放、WASD 移动。

```text
cd examples
npm run dev
open http://127.0.0.1:5173/r5-showcase/
```

本页面是当前能力的综合演示，不替代 R5 各 FX/G5 的正式 benchmark/Gate，也不把尚未关闭的
FX-09..12/G5-P 宣称为已经完成。
