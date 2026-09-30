# Appearance 编译数值诊断

这是组件级 diagnostic，不生成 accepted evidence，也不替代本地 Chrome 整帧、画质或性能验收。使用实际 `AppearanceGraphCompiler` 与 `appearance_program`，在独立 D3D12 设备中编译、异步创建并执行 kernel，读取数值与 CPU 对照；每个源叶是真实 GPU 纹理，RGB/alpha 的 sRGB 行为分别验证。测试设备与测试 submit 仅属于宿主。

先在 `OEngine` 运行 `npm run build:test`。外部测试 runtime 使用 `webgpu@0.6.1`，安装在忽略目录，不加入生产依赖。例如在仓库根执行：

```powershell
npm install --prefix .local/surface-gpu-oracle --no-save --package-lock=false webgpu@0.6.1
node validation/labs/surface-appearance/appearance-gpu-oracle.mjs .local/surface-gpu-oracle
```

Raw 输出写入 `.local/validation/surface-appearance/gpu-oracle.json`。验证 complete Standard/Coated、unlit、Dungeon ORM/AO alias、零 RGB/alpha/normal scale 与全部 IR 算子，256 lanes/组。只证明新生成 WGSL 的已测数值与编译，尚无 RenderWorld→新 Surface 生产 consumer 证据。当前 1×1 源纹理不验证 footprint、各向异性、缓存 seam/LOD；相应范围必须在后续模块补齐。

发布组件增加独立宿主：

```powershell
node validation/labs/surface-appearance/appearance-resident-gpu-oracle.mjs .local/surface-gpu-oracle
```

它直接使用生产`AppearanceProgramRegistry`、`GpuAppearancePublication`和resident kernel：同一command先copy发布buffer再消费task，使用2×2、两layer的真实texture array、各bank与固定sampler profile，核对Coated两材质共享PSO、多UV、仿射采样、linear alpha、语义fallback及无纹理程序。这里的纹理已是resident scene-linear数据，不能按author sRGB再解码。Raw写入`resident-gpu-oracle.json`；五组14,592值，最大绝对误差`5.96046448e-8`。本地Dawn会输出adapter初始化及pipeline cached-blob HRESULT诊断，虽然API validation/uncaptured errors与device loss为零，不能描述为无原生诊断或Chrome兼容结论。全bank×全sampler采样原型曾长时间编译而中断，没有通过记录；最终内核按每sample资源profile直接绑定，原型已删除。

两个宿主均不证明生产Surface已切换、不统计性能收益，也未覆盖各向异性、动态footprint/驻留更新、normal variance、cache seam/LOD或完整连续画面。

静态half产品第三个组件宿主：

```powershell
node validation/labs/surface-appearance/appearance-asset-gpu-oracle.mjs .local/surface-gpu-oracle
```

实际cook（先half量化再质量probes）→RuntimeAsset包往返→调用者拥有的array layers→同一command事务copy→GPU bilinear/trilinear sample→数值readback。NPOT 5×3、三层mip、r16float/rg16float/rgba16float及f32常量；12个copy、256 lanes/3,328值。比较GPU过滤与packed CPU参考（最大`0.000162751`），也比较该fixture源表达式（最大`0.018849826`），后者在显式0.025预算内；这个预算不作为任何生产画质默认或结论。Payload 396 bytes、padded staging与实际buffer各2228 bytes。Raw为`asset-gpu-oracle.json`。

上传helper不创建或拥有长期texture，正式Appearance residency/cache owner和材质program替换consumer尚未接通。有限probes与这个GPU fixture不证明连续域完全等价，不证明normal variance/roughness、anisotropy、chart seam/LOD、Chrome画质或性能。Dawn原生adapter/cache blob诊断同前两个宿主。

静态产品重连第五个组件宿主（长期静态owner已接通，替代上文尚无owner的早期组件状态）：

```powershell
node validation/labs/surface-appearance/appearance-product-gpu-oracle.mjs .local/surface-gpu-oracle
```

真实原图cook→产品绑定/裁剪→`AppearanceStaticResidency`→`GpuAppearancePublication`→实际PSO消费，5组/4,864值。静态内部root+动态target与保留源fallback误差0；base/coat独立过滤后共享array不同layer最大0.004868925（fixture预算0.01）；精确HDR常量0且无texture；非单位域NPOT最大0.000976563（fixture预算0.001）。Raw为`product-gpu-oracle.json`。发布目录以32-byte stride携带独立physical resource-set index，不将相同PSO误当相同texture set。API errors/device loss零，Dawn原生adapter/cache诊断仍在；不是Chrome结论。普通scene材质产品authoring、portable字段版本失效、新Surface主链、动态缓存与最终视频/性能仍未完成。

联合法线第四个组件宿主：

```powershell
node validation/labs/surface-appearance/appearance-normal-gpu-oracle.mjs .local/surface-gpu-oracle
```

真实NPOT half矩上传→GPU spatial/fractional-LOD滤波→生产`appearance_normal_filter`解码，256 lanes/2,048值，包括取消矩/单位矩/负Z。Raw为`normal-gpu-oracle.json`。GPU decode对实际采样矩的CPU f32参考误差`1.1920929e-7`，硬件滤波对packed CPU高精度滤波误差`0.003502712`；后者超过初始0.0003断言（失败保留在`normal-gpu-oracle-filter-failure.json`），不能把两者混称数值精确。最终诊断fixture单独声明矩0.005、方向0.01rad、roughness0.025预算，并实际检查最终方向`0.004642322`rad/roughness`0.010636690`；这些只是fixture预算，CPU cook的有限探针不包括硬件滤波差异。该组件不证明法线已进入新Surface、所有硬件/连续域画质或性能，来源采用状态不变。
