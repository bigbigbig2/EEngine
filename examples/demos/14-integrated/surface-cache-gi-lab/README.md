# Surface Cache GI 实验屋

不需要下载模型。这个示例用程序化盒体和球体搭建连通室内场景，通过正常的 `cookSceneGeometryProductV1 → uploadCookedSceneProduct → Renderer.render` 路径运行现有 SCGI。不导入 oracle fixture，不访问或替换 Renderer 私有 owner，也没有另建 GI 渲染器。

这是供开发者和用户日常观察、调试的 demo，为后续 SCGI-10 准备实验条件；创建该示例不代表完成 SCGI-10 的画质、全组合、动态响应或性能验收。

## 启动

从仓库根目录运行：

```powershell
npm --prefix examples run demo:scgi
```

或者用已有 examples dev server 打开：

```text
/demos/14-integrated/surface-cache-gi-lab/index.html
```

**默认和当前最高输出尺寸为 1920×1080，internal scale 默认为 1.0。** 不根据窗口大小、DPR、估计显存或运行速度自动降低分辨率。画布会适应页面宽度，实际渲染尺寸见下方 Output / internal 指标。640、960、1280 宽度及较低 internal scale 仅供主动调试选择。

可选 URL 参数：

```text
?paused                       首次准备完成后暂停，保留默认 1080p / scale 1.0
?paused&width=640&scale=0.5    显式选择小尺寸，适合工具调试
```

`width` 支持 320、640、960、1280、1920；`scale` 支持 0.5、0.667、0.75、1。未提供或不识别的参数保留默认设置。这些参数不改变 GI 算法或遗漏几何，页面面板和导出的 JSON 会反映实际选择。

启动只提交一帧后即开放面板，不在首次可操作前强制连续暖机多帧。连续渲染仍会继续累积；如需固定状态，可用 `?paused` 启动。几何 streaming / query cut 尚未就绪时的前几帧不能视作完整 GI 的成本或效果。

## 场景与实验

房间按米制搭建，主室内范围约为 10×8×3.2 m。墙、屋顶、门和遮板均有厚度；没有为拍摄总览移除屋顶或侧墙。所有几何先进入同一 GeometryProduct，门、窗、挡板和发光片通过正常刚体变换更新。

| 实验            | 用途                         | 建议操作                                                 |
| --------------- | ---------------------------- | -------------------------------------------------------- |
| 窗口日光        | 分开观察直射和室内反弹       | 调节窗开启比例、太阳高度、天空亮度；固定曝光             |
| 门开合          | 跨房间传播与历史响应         | 暗室相机，切换门开合或播放刚体实验                       |
| 彩色反弹        | 红绿墙向白色接收面的色彩传递 | 切换彩色墙、单跳 / 多跳；观察 world irradiance           |
| 移动自发光      | 仅由发光材质产生的间接光     | 黑色基底的 HDR 发光片；观察移动、停下、熄灭后的残留      |
| 拐角 / 离屏遮挡 | L 形走廊中的可见性与传播     | 光源在视野外，移动走廊挡板；同时查 confidence            |
| 近场接触        | Gather 的局部残差作用        | 桌腿、薄隔板、细杆；比较最终画面与 world-only appearance |

另有主厅、暗室、走廊、发光角落、接触、窗口与室内总览七个固定观察点。左键环绕、右键平移、滚轮推进；未启用键盘平移，避免编辑参数时误移动相机。

“全屏查看”放大画布显示，Esc 返回；这个操作不修改实际渲染分辨率。导出的 PNG 保留实际输出尺寸，适合按像素放大检查。

默认点光源为零，日光走 Physical Environment / VSM。发光实验不附带点光源，不用额外环境补光掩盖 GI 误差。金属球是 specular 对照物，不是 diffuse GI 接收面。

R3 后 diffuse source 调试图只展示实际请求且完成的源；紫色表示未请求或无有效源，黑色才可能是有效的零辐亮度。稀疏紫色背景不是最终画面，也不表示这些位置没有执行主 Surface 着色。

## 操作语义

面板参数先暂存，点“应用参数”后才在上一主机帧准备结束的边界统一应用。编辑中的值不会提前改变连贯渲染的场景。

- **预设**：恢复场景光照基准、设置对应相机、回到动作 tick 0，并清空 GI / 画面历史；保留用户选定的 GI 质量、输出尺寸和曝光。
- **固定观察点**：重置画面历史，保留 world cache；普通鼠标移动不人为清空 GI。
- **应用参数**：启用 Gather 时提交两帧，使暂停状态下的调试画面也能消费上一已提交帧的残差，而不是只显示重置后的空历史。
- **暂停渲染 / 单步**：暂停主循环；单步提交一帧。动画启用时，每个已提交的场景步推进 1/30 模拟秒，不随 GPU 速度改变轨迹。
- **播放刚体实验**：门、遮板或挡板往复移动；自发光片横移，并在每周期末熄灭。取消勾选并应用会停在当前姿态；同次编辑明确输入的新姿态优先。
- **累积指定帧**：固定当前动作 tick 累积，不偷偷播放动画。渲染结束后暂停。
- **清空 GI / 历史**：先通过正常关闭效果的已提交帧退休 GI owner，再恢复设置和清空画面 / 曝光历史。重新累积从恢复后的帧开始。不直接清零内部 GPU buffer。
- **冻结 Gather 历史**：仅控制现有 `gatherFreeze`，world GI 仍更新。不是全局 GI 冻结。
- **修改固定曝光**：现有 Renderer 的曝光配置不可变，因此等待队列完成、销毁原 Renderer，再上传同一个 CPU GeometryProduct。该操作会重置历史，界面明确显示重建状态。

切换尺寸、表示、容量或效果可能重建 GPU 工作集并带来编译等待。资源或设备能力不足会显式报错，不静默降分辨率、截断场景或跳过像素。默认是完整软件 query 路径，交互速度取决于设备与设置。

## 调试信号

所有调试视图调用现有 `setSurfaceCacheGiSettings({ debug })`：

| 视图                   | 内容                                                                               |
| ---------------------- | ---------------------------------------------------------------------------------- |
| 最终画面               | 原生材质、直接光、world GI 和启用的 Gather 等最终合成                              |
| 最终画面 / 仅 world GI | 保留材质与直接光，只移除 Gather 修正的 appearance 对照                             |
| World irradiance       | world field 的辐照度，不混同最终材质颜色                                           |
| 组合 irradiance        | world 与置信度加权的 near-field residual                                           |
| World confidence       | 当前已有 world field 的可信度                                                      |
| Signed residual        | 红表示正修正，蓝表示负修正；负数是合法结果                                         |
| Gather confidence      | 近场残差可信度                                                                     |
| Diffuse source         | Gather 的 diffuse 输入，含自发光与带 query 阴影的 diffuse lighting；不读取最终 HDR |

关闭 GI 时，没有可消费的 GI 调试产品；关闭 Gather 后，Gather 调试不能证明存在近场修正。不要把黑色当作正确遮挡的充分证据，须结合 confidence 和工作集判断。cache age、query unknown 等额外 GPU 可视化尚未新增，本示例没有以假的数值代替它们。

面板提供 world cache、请求容量、更新数、半球样本、连接与光源样本、多跳、过滤 taps、Gather 距离、tile、方向数、执行 batch、query 预算及 AO / SSSR / Bloom / temporal / jitter / VSM 控制。`batchRays` 和 `gatherBatchRays` 是执行批大小，不是“每像素发多少 ray”的画质设置。

当前 demo 的 Gather batch 为 65536，使完整 1080p 工作集不被极小批次拆成大量 query 命令。R2 将 Estimator 改为扁平的 patch×sample 工作，默认 batch 因此改为 1024：128 个更新×8 个半球样本可合入一个物理窗口，256 个重连接样本另一个窗口。128 是旧逐 sample 调度的配置，不再是合理的批量基线；扩大执行窗口没有减少更新数、样本或 query 完整性。`?batch=128` 可显式比较小批次成本；`?timing=stage` 开启有限阶段时间戳，默认保留 coarse 整帧采样。

初始大 batch 调整曾将 Gather dispatch 理论上界从 100121 降至 6455，完整 probe / source shadow ray 上界仍分别为 230400 / 1036800，history 大小不变；Gather owner 和 query 私有 batch 资源合计增加约 28.125 MiB。随后 R1 切换共享 query，R2 切换 estimator 批处理；最新默认 1080p 样本为481次整帧 dispatch、coarse GPU command span约68.29ms，尚未达到实时性能。R2 stage 样本 estimator约2.25ms、未改造的 Gather source约24.06ms。数值是短序列观测，不能当正式benchmark或最终画质通过；原失败与版本/参数差异见执行文档§8。

## 截图、条件和比较

“截图 + JSON”暂停渲染，在队列完成后把当前 canvas 导出为 PNG，并生成 JSON。页面下方提供预览和两个下载链接。画廊最多保留九项，淘汰时释放 host Blob URL；不额外复制 GPU history。

JSON 包括：

- 当前相机位置、目标、投影与 view-projection，场景基准与当前动作姿态、动作 tick。
- 实际提交帧数、自 GI 重置以来的提交帧数、输出与 internal 尺寸、曝光、全部 SCGI 设置。
- SCGI owner 的字节规模、history / scratch / query 成本、ray 与 dispatch 上界。
- 引擎内存记账、temporal 状态、提交状态、最近 profiler 采样、设备实际 features / 相关 limits 和错误。

“生成三组独立暖机对比”在相同相机、姿态、光照、曝光与尺寸下，依次生成 **GI off / world GI / world + Gather**。每组清空 GI 并累积相同帧数，忽略当前 Gather freeze 以避免空历史被固定。结束后恢复用户的效果设置，重新暖机并暂停。

这是独立暖机的可复现实验条件，**不保证三组具有相同的随机相位或逐样本 cache 内容，也不是高 spp path tracing 真值比较**。对比恢复阶段不会自动恢复连续渲染。页面截图、JSON、热身帧数应一起保存，不能只凭一张噪声不同的截图宣称 Gather 的质量收益。

## 数据边界与当前可观察问题

`Renderer.surfaceCacheGiEvidence()` 是按需 CPU 成本快照，生命周期从 GI owner 创建到退休；未创建 / 已退休返回 `null`，不暴露 GPU 产品、不提交命令、不执行 readback。成本里注明排除项。`queryArenas` 仅说明 CPU 已提交 publication 的共享 AS arena 数；冷启动的零 arena 不代表已运行完整几何 query，非零也不替代 GPU coverage 证明。源 BLAS 块不再等同于 query 调度次数。主机循环不依赖 GPU readback 决定效果工作，profiler 的异步时间戳采样只用于显示。

Owner 字节不是驱动总显存；ray / dispatch 数是编码理论上界，不是实际命中数。GPU command span 只显示实际完整时间戳采样；不可用时明确显示不可用。它不是 P50 / P95 或 FPS 资格。

现有低样本 GI 的斑块、缺覆盖和自发光强源噪声会直接显示，示例没有通过额外补光、隐藏残差或换假图片消除它们。这些正是后续需要用该场景定位的问题。

主画面的局部点光源阴影尚未完整接入，而 GI source 已有 query shadow；因此默认不使用点光源作为遮挡验收光源。当前场景是 static / rigid opaque；没有扩展 skin / morph、透明、复杂资产压力和跨设备资格。

## 开发检查

```powershell
npm --prefix examples run typecheck:scgi
npm --prefix examples run build:scgi
```

该 demo 会被 examples 的自动发现与 Storybook catalog 收集；没有新加另一套场景测试框架。浏览器工具可调用 `window.scgiLab` 的 `snapshot / advance / preset / view / debug / reset / capture / compare`；这些入口复用同一操作队列，不暴露内部 GPU buffer，也不修改生产 shader 或缓存内容。截图和场景检查结果仅适用于对应设置，不提升 SCGI-10 状态。
