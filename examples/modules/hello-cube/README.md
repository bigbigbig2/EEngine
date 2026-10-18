# Hello Cube

最小的 EEngine 模块示例：一个薄地台、一个立方体、一个 authored `DirectionalLight` 和 `OrbitControls`。

场景通过 `cookSceneGeometryProductV1()` 生成 GeometryProduct，再由
`Renderer.uploadCookedSceneProduct()` 发布到正式的 Virtual Geometry runtime。

这个示例刻意关闭 Physical Environment、VSM、HZB、GTAO、Bloom、FSR3 和
temporal jitter，用来观察最小的几何可见性、Native Surface 和 present 路径。
