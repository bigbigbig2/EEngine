# R2-D-08 · Packed Material 属性重建与解析梯度

## Reference

- Reference ID：`R2-D-08-THREEJS-MATERIAL-RECONSTRUCTION`
- upstream project：three.js
- repository URL：https://github.com/mrdoob/three.js
- locked commit：`7cda7e710d884827fc73ff1a3aa63270846513d7`
- source/example：`examples/webgpu_compute_rasterizer_ibl.html` 的 fullscreen resolve、perspective-correct barycentric、analytic UV gradient、`textureSampleGrad` 与 normal/tangent reconstruction
- license：MIT；本地 `three.js/LICENSE` 保留完整 notice
- maturity class：official runnable WebGPU example
- verified on：2026-08-27
- decision：`port`（barycentric/gradient 不变量）+ `reimplement`（OEngine ABI/stream decode/transform frame）

## 保留不变量

- Visibility pixel 反查精确 triangle vertices；screen barycentric 先计算，再以 reciprocal-W 归一化。
- UV 的 `ddx/ddy` 由同一三角形解析求导；相邻 fullscreen invocation 可能属于不同 triangle，因此禁止使用硬件 `dpdx/dpdy`。
- 所有贴图使用 `textureSampleGrad`，避免错误 mip 选择。
- normal/tangent/UV/color 以相同 perspective weights 插值。

## OEngine 差异

- `GPUViewContext.projection_matrix` 已包含 viewport transform，投影结果除以 W 后直接是 top-down pixel coordinates；不再次执行 NDC→screen 映射。旧 Packed 实现的重复 viewport 变换已删除。
- 每个 semantic 每像素只执行一次 `find_stream()`；三个 vertex 复用 descriptor。position/normal/tangent/uv/color 从约 15 次线性 descriptor 扫描降为 5 次。
- normal 使用 inverse-transpose 等价 cofactor，并以 determinant orientation 修正镜像变换；tangent 使用 object-to-world 线性 3×3，bitangent 使用 `cross(N,T) * tangent.w * orientation`。
- 奇异 transform 和退化向量走有限 identity/safe-normalize fallback，禁止 NaN/Inf 扩散。
- 当前仍是按活跃材质重复 fullscreen 的旧 Material Expand；R4-B 必须迁移到单次 Material Resolve，不能把本次局部优化当作最终架构。

## 精度、性能假设与验证

使用 f32 WGSL；解析导数 CPU oracle 以双精度计算，并与中心有限差分对照。性能假设是删除错误的 quad derivative 和 10 次重复 descriptor scan；增加 barycentric derivative 算术。只有 R4-B 前后的同条件 GPU timestamp 才能声明实际收益。

本地验证：`packed-r2-algorithms.test.mjs` 覆盖不同 W、顶点命中、权重/导数守恒、UV 有限差分、镜像非均匀 normal/tangent、Shader 禁止 `dpdx/dpdy` 和 lookup 次数；`npm run audit:shaders` 覆盖 runtime source owner。浏览器画面/diagnostic 需要重新运行 Packed A/B 或 `r2-packed-scene` 后登记。
