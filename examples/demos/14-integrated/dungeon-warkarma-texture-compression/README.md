# Dungeon Warkarma: Texture Compression

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
npm run typecheck:dungeon
npm run build:dungeon
npm run demo:dungeon -- --port 5175
```

页面：`http://localhost:5175/demos/14-integrated/dungeon-warkarma-texture-compression/index.html`。
独立构建输出到本目录 `dist/`，包含本例自己的 GLB、几何包和全部纹理包。
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
node examples/demos/14-integrated/dungeon-warkarma-texture-compression/build-playground.mjs
```

从仓库根目录重新 cook（工具链前提与 Bistro 相同）：
原生 BC 构建需要支持 C++20 signed shift 的编译器；本机使用校验过下载摘要的
LLVM-MinGW 20261006。旧 GCC 8 无法构建当前固定版本 Basis。

```powershell
npm install --prefix .local/offline-cook-deps pngjs@7.0.0 sharp@0.34.5 --no-audit --no-fund
node tools/test-build.mjs
$env:CXX = (Resolve-Path .local/toolchains/llvm-mingw-20261006-ucrt-x86_64/bin/clang++.exe).Path
node OEngine/tools/build-native-cooker.mjs
node OEngine/tools/build-pc-texture-native.mjs
node OEngine/tools/cook-offline-scene.mjs examples/demos/14-integrated/dungeon-warkarma-texture-compression/assets/dungeon_warkarma.glb .local/models/dungeon-warkarma-cooked 4
node OEngine/tools/verify-offline-scene.mjs .local/models/dungeon-warkarma-cooked
```

WebP 在离线阶段解码为原尺寸 straight RGBA，随后使用现有完整 mip 与
`bc7e-scalar-6-bc4-hq` 编码流程。`EXT_texture_webp` 的 source 在离线材质导入前解析。
发布时将 `scene.oescene`、`scene.materials.json`、全部 `.oegpack` 与
`textures/*.textureproduct` 从 cook 输出复制到本例 `assets/cooked/`。
中间描述、scratch 和进度记录保留在 `.local`，不属于运行时资源。

模型来源与历史许可记录见 `assets/SOURCE.md` 和 `assets/LICENSE.txt`。
本示例与原例一样不构成整套 renderer 的画质或性能验收。
