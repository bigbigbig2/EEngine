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
