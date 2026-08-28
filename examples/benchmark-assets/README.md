# OBS-02 benchmark assets

`teapot-lod-*.glb` 是由 `npm run generate:benchmark-assets` 机械生成的固定 benchmark 输入，不是 OEngine 运行时依赖。

- 上游：three.js
- revision：`7cda7e710d884827fc73ff1a3aa63270846513d7`
- source：`three.js/examples/jsm/geometries/TeapotGeometry.js`
- license：MIT（见 `three.js/LICENSE`）
- 参数：size=1、segments=`10/8/6/5/4/3/2`，body/lid/bottom/fitLid/blinn 全部启用

生成器只把上游 `BufferGeometry` 的 position/normal/uv/index 封装成 GLB。OEngine R3 主链已经消费由自身 Cooker 生成的 Cluster hierarchy/SSE；其余预制 LOD 继续冻结 three.js 精确输入契约，但页面尚未直接消费这些独立文件，该资产配方差异由 `COOK-11` 跟踪。

## Damaged Helmet

`damaged-helmet/` 从本地 three.js revision
`7cda7e710d884827fc73ff1a3aa63270846513d7` 的
`examples/models/gltf/DamagedHelmet/glTF/` 原样复制，作为 B 页面真实
glTF → SourceGeometry → Cooker → Package → Packed Scene 的固定输入。

- 原项目：Khronos glTF Sample Models / Damaged Helmet
- 本地来源：`three.js/examples/models/gltf/DamagedHelmet/`
- 许可：Creative Commons Attribution-NonCommercial（CC BY-NC）
- 使用边界：只用于 benchmark、研究和本地验证，不作为 OEngine 可再分发的运行时资产

来源说明和署名保存在 `damaged-helmet/README.md`。
