# OBS-02 benchmark assets

`teapot-lod-*.glb` 是由 `npm run generate:benchmark-assets` 机械生成的固定 benchmark 输入，不是 OEngine 运行时依赖。

- 上游：three.js
- revision：`7cda7e710d884827fc73ff1a3aa63270846513d7`
- source：`three.js/examples/jsm/geometries/TeapotGeometry.js`
- license：MIT（见 `three.js/LICENSE`）
- 参数：size=1、segments=`10/8/6/5/4/3/2`，body/lid/bottom/fitLid/blinn 全部启用

生成器只把上游 `BufferGeometry` 的 position/normal/uv/index 封装成 GLB。OEngine 当前 OBS-02 页面只消费最高细节输入；其余 LOD 用于冻结后续 `WORK-04` 的同输入契约，不冒充已经实现 hierarchy/SSE LOD。
