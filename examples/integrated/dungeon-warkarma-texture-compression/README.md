# Dungeon Warkarma: Texture Compression

当前默认`assets/playground-cooked/`已接入修复后的`dungeon-fixed-high-r2`并重新组合playground；`assets/cooked/`是同一新版Dungeon本体。固定High产物明确未执行完整质量选优，不把成功加载视为画质或性能验收。

独立复制 `bistro-texture-compression` 的页面、样式、太阳日历、控制项和场景加载代码，
默认加载本目录 `assets/playground-cooked/` 中的组合场景，包含 Dungeon Warkarma
及其周围的 playground。Dungeon 原始离线产物保留在本例 `assets/cooked/`。
VSM 和日期太阳默认开启：2026 年第 44 天（2 月 13 日）、13:00、纬度 35°、
经度 0°、直射太阳 2.20、天空能量 3.00，固定曝光 5。
引擎和 npm 依赖仍使用工作区版本；示例文件和模型资源不引用 Bistro 或 shared 示例目录。

VSM 面板提供以下实时调试参数，滑块松开后生效：

| 参数 | 默认值 | 用途 |
| --- | --- | --- |
| PCF samples | 4×4 | 1×1 至设备允许的上限，比较过滤质量与采样成本 |
| Filter radius | 0.75 texel | 0–3，调整过滤宽度，不是物理光源软阴影半径 |
| Depth / Normal / Slope bias | 2 / 0.5 / 1.5 texel | 分别调整深度、法线相关与斜率相关偏移；过大会使阴影脱离物体 |
| Coverage scale | 1× | 0.25–4，扩大范围会降低世界空间精度，并重建页面 |
| Rebuild pages / Reset VSM | — | 手动失效重建 / 恢复全部默认参数 |

Debug view 可选阴影可见度（白受光、黑遮挡）、实际采样 clip level，或页面状态
（绿 Fine、蓝 Coarse、紫 Missing、红 Stale、黄 Dirty、灰 Outside）。青色表示没有
caster 深度或物体不接收阴影。颜色经过现有显示映射；调试视图只用于检查，测画质或性能时关闭。

在 `examples` 目录运行：

```powershell
yarn typecheck:dungeon
yarn build:dungeon
yarn demo:dungeon
```

页面：`http://localhost:5176/integrated/dungeon-warkarma-texture-compression/index.html`。
独立构建输出到 `examples-static/integrated/dungeon-warkarma-texture-compression/`，只包含已发布场景引用的几何、图片/精确段、目录和收据，不包含源 GLB 或搜索中间文件。
运行时的几何流式读取需要静态服务器支持 HTTP Range；开发服务器已提供支持。
`?mode=raw` 保留原始 Dungeon 的浏览器 cook 入口，不包含 playground；
`?fixture=1` 不切换到任何共享测试模型。

Playground 包含约 184×184 的大地面、8 段墙、15 个方块、15 个球体和 5 级台阶，
共 8 种 PBR 材质：哑光地面、混凝土、陶土、蓝色漆面、钢、金色金属、青绿橡胶、白瓷。
摆放使用固定随机种子，避开 Dungeon 的主体区域。相机取景覆盖建筑和周边物体，
不把巨大地面的边缘纳入自动取景。新增几何走既有离线 Geometry Product 路线，
与 Dungeon 在一次场景 publication 中发布。

重新生成并 cook playground（不重新编码 Dungeon 纹理）：

```powershell
node examples/integrated/dungeon-warkarma-texture-compression/build-playground.mjs
```

从仓库根目录重新 cook（工具链前提与 Bistro 相同）：
需要当前几何 Cooker、固定 libavif/libaom 工具及 canonical mip resampler。
纹理不再由离线原生 BC 编码器生成；完整搜索使用本地 evaluation GPU，须与其它 GPU 验证串行。

```powershell
npm install --prefix .local/offline-cook-deps pngjs@7.0.0 sharp@0.34.5 --no-audit --no-fund
node tools/test-build.mjs
$env:CXX = (Resolve-Path .local/toolchains/llvm-mingw-20261006-ucrt-x86_64/bin/clang++.exe).Path
node OEngine/tools/build-native-cooker.mjs
node OEngine/tools/build-image-resampler-native.mjs
$env:EENGINE_IMAGE_QUALITY = "high"
node OEngine/tools/cook-offline-scene.mjs examples/assets/three/rendering-lab/dungeon_warkarma.glb .local/models/dungeon-warkarma-cooked 1 --vt
node OEngine/tools/verify-offline-scene.mjs .local/models/dungeon-warkarma-cooked
node OEngine/tools/extreme-web-asset/scene-package.mjs .local/models/dungeon-warkarma-cooked examples/integrated/dungeon-warkarma-texture-compression/assets/cooked
node examples/integrated/dungeon-warkarma-texture-compression/build-playground.mjs
```

WebP 在离线阶段解码为原尺寸 straight RGBA，canonical mip 完整生成后编码为 AVIF，
alpha/coverage 使用独立精确段。`EXT_texture_webp` 的 source 在离线材质导入前解析。
VT 每张纹理完整评价 60 个候选，不删 mip、不先做 BC 往返。浏览器下载图片后由统一
Worker 准备，再由 GPU 编码并写入 BC 驻留页。publisher 校验最终目录、payload、
receipt 和完整 search report 后复制不可变依赖，最后原子替换 `scene.materials.json`。
中间描述、scratch 和进度记录保留在 `.local`，不属于运行时资源。
示例的本地 Spark evaluation 挂载不代表生产分发授权；公开部署需合法配置 kernel 来源。

模型来源与历史许可记录见 `assets/SOURCE.md` 和 `assets/LICENSE.txt`。
本示例与原例一样不构成整套 renderer 的画质或性能验收。
