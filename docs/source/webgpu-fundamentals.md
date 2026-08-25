# WebGPU 基础

| 阶段 | WebGPU 章节                        | 对应 WebGL 概念                           | 你要掌握什么                                          |
| ---- | ---------------------------------- | ----------------------------------------- | ----------------------------------------------------- |
| 1    | 基础知识                           | `gl.createProgram`、`gl.drawArrays`       | WebGPU 初始化、pipeline、command encoder、render pass |
| 2    | Inter-stage 变量                   | `varying` / `in out`                      | 顶点 shader 如何把数据传给片元 shader                 |
| 3    | Uniforms                           | `gl.uniform*`                             | CPU 如何把颜色、矩阵、时间等数据传给 shader           |
| 4    | Vertex Buffers                     | `gl.bindBuffer`、`gl.vertexAttribPointer` | 顶点数据如何从 JS 数组进入 GPU                        |
| 5    | Storage Buffer                     | WebGL 无直接等价，类似大数据 buffer       | 大量结构化数据、实例数据、计算数据如何传给 GPU        |
| 6    | 纹理 / 加载图像                    | `gl.createTexture`、`gl.texImage2D`       | 图片、采样器、纹理坐标、texture view                  |
| 7    | 数据内存布局                       | WebGL 中较少显式处理                      | uniform/storage buffer 的对齐规则                     |
| 8    | 透明度与混合                       | `gl.enable(gl.BLEND)`                     | alpha、blend state、透明物体排序                      |
| 9    | 绑定组布局                         | uniform block / texture unit              | `BindGroupLayout`、资源绑定体系                       |
| 10   | 3D 数学                            | matrix、camera、MVP                       | 平移、旋转、缩放、投影、相机                          |
| 11   | 光照                               | GLSL 光照模型                             | normal、directional light、point light、spot light    |
| 12   | 后处理 / Picking / Camera Controls | FBO、Raycast、OrbitControls               | Web3D 编辑器常用能力                                  |
| 13   | Compute Shader                     | WebGL 贴图模拟 GPGPU                      | WebGPU 的真正优势：GPU 并行计算                       |





**WebGPU 的目的只有两件事：**

1. **把三角形 / 点 / 线 渲染到一块纹理上（通常是 `<canvas>`）**
2. **在 GPU 上执行并行计算**

这是它的核心功能，其他都是围绕这两点展开的。

这个定位和 WebGL 有根本不同：WebGL 是把 OpenGL ES 的渲染状态机风格 API 暴露到 JavaScript；而 WebGPU 是更底层、更显式的现代 GPU API，跟 Vulkan / Metal / D3D12 更像。我们后面会详细对比这两个 API 在实现上和概念上的差异



## 一、WebGPU 为什么被设计出来？（对比 WebGL）

### WebGL

WebGL 的设计主要是把 GPU 渲染映射为一种浏览器环境下的状态机：

```
gl.useProgram(program)
gl.bindBuffer(...)
gl.drawArrays(...)
```

其特点：

- 很多 GPU 状态是“隐式”的，比如哪个 program 正在用、哪个 buffer 正在绑定。
- 在使用上比较简洁，但不明确 GPU 在什么时候做了什么。
- 着色器语言是 GLSL ES；uniform 是单独设置的状态。

这是因为 WebGL 的目标是兼容旧的 OpenGL ES，而 GPU 历史也主要是固定功能管线。

### WebGPU

WebGPU 设计目标是现代 GPU API：

- **资源、管线、命令提交更显式**
- **状态不可隐式切换，必须在创建 pipeline / render pass 时定义清楚**
- 不提供全局状态机，而是**描述式配置 + 录制命令**
- 运行时性能更可控

WebGPU 把很多原来 WebGL 里的全局状态变成“不可变的资源 / 不可变的管线对象”。比如 uniform 不再是动态设置，而是**Uniform Buffer** 和 **Bind Group** 的组合。

换句话说，WebGPU 不像 WebGL 那样“剥夺你控制的权利”，而是让你明确告诉 GPU 你要什么并**以最小隐藏来运行**。

这也意味着在 WebGPU 中你可能写的代码比 WebGL 更复杂，但 GPU 的执行会更加确定和高效。



## 二、WebGPU 的三个最基本的着色器类型

这一章特别强调：WebGPU 在 GPU 上可以执行三种核心函数：

1. **Vertex Shader（顶点着色器）**
    负责计算顶点的位置。每次从传入的顶点数据里取一个顶点，并输出其最终位置坐标。
    WebGPU 里每三个输出一个三角形。
2. **Fragment Shader（片元着色器）**
    在几何体被光栅化成像素时执行，为每个像素计算颜色。
3. **Compute Shader（计算着色器）**
    并不负责绘制；它更类似 GPU 里的“并行函数”，可执行 N 次相同的运算指令集合。
    例如计算粒子系统、生成数据、对图像做复杂变换等。

对比：

- WebGL 也有顶点与片元 shader，但它没有原生的计算着色器支持（通常要用贴图 hack 实现）。
- WebGPU 的 compute shader 是**第一等角色**，强调 GPGPU 计算能力



## 三、最小的 WebGPU 程序：画一个三角形

这一章最核心的演示代码就是一个“最小三角形例子”的分步解释。下面是重点对比：

### 1. **初始化 GPU**

WebGL：

```
const gl = canvas.getContext("webgl2")
```

WebGPU：

```
const adapter = await navigator.gpu.requestAdapter();
const device = await adapter.requestDevice();
const context = canvas.getContext("webgpu");
const format = navigator.gpu.getPreferredCanvasFormat();
context.configure({ device, format });
```

对比：

- WebGL 只需要取得 context 即可。
- WebGPU 需要先取得 **Adapter → Device → Canvas Context → Configure**，
- WebGPU 的 `device` 是你和 GPU 之间的核心对象，它负责创建所有 GPU 资源（buffer、texture、pipeline 等）。

------

### 2. **Shader 模块**

在 WebGPU 中着色器写在 WGSL 里，而不是传统 GLSL：

WebGPU 示例中的顶点 shader：

```
@vertex fn vs(@builtin(vertex_index) vertexIndex : u32) -> @builtin(position) vec4f {
  let pos = array(
    vec2f( 0.0,  0.5),
    vec2f(-0.5, -0.5),
    vec2f( 0.5, -0.5)
  );
  return vec4f(pos[vertexIndex], 0.0, 1.0);
}
```

对应简单三角形的三个顶点。

片元 shader：

```
@fragment fn fs() -> @location(0) vec4f {
  return vec4f(1.0, 0.0, 0.0, 1.0);
}
```

这段代码表示：这个 fragment shader 输出一个纯红色像素。

对比 WebGL GLSL：

```
void main() {
  gl_Position = vec4(position,1.0);
}
```

WGSL 的写法更加显式：

- 每个 shader 都用 `@vertex` / `@fragment` 标记
- 输入输出使用 `@builtin(...)` 和 `@location(...)` 指定
- 需要静态类型声明语法

这是 WebGPU 的**显式强类型设计风格**。

------

### 3. **Pipeline vs Program**

WebGL 概念里：

- program = vertex shader + fragment shader

WebGPU 里：

- Render Pipeline

   不只是 shader，它还包含：

  - 顶点 shader
  - 片元 shader
  - 输出格式（canvas 颜色格式等）

代码示例：

```
const pipeline = device.createRenderPipeline({
  layout: 'auto',
  vertex: { module, entryPoint: 'vs' },
  fragment: { module, entryPoint: 'fs', targets: [{ format: presentationFormat }] },
});
```

注意这里的 `layout: 'auto'` 意味着让 WebGPU 自动推断资源绑定布局，在更复杂场景你会自己手写布局。

对比 WebGL：

```
gl.linkProgram(program)
```

在 WebGL 里程序只负责 shader 逻辑，状态（深度测试、混合等）是在别的 API 调用里设置。

WebGPU 把这些状态**提前固定在 pipeline 里**。

------

### 4. **命令提交的模式**

WebGL 是即时执行 API 调用，但 WebGPU 是**批命令编码器模式**：

你不会直接 draw，而是：

```
const encoder = device.createCommandEncoder();
const pass = encoder.beginRenderPass({...});
pass.setPipeline(pipeline);
pass.draw(3);
pass.end();
const commandBuffer = encoder.finish();
device.queue.submit([commandBuffer]);
```

这个流程本质上和 Vulkan/Metal 更像：

- 所有绘制命令先编码到一个 command buffer
- 最后统一提交给 GPU
- 可以混合多个 render pass、compute pass 等共用同一个命令缓冲区

对比 WebGL：

```
gl.drawArrays(...)
```

简洁，但“什么时候 GPU 真正执行”是 WebGL 内部负责的。







#   Inter-stage 变量



**WebGPU Inter-stage 变量**
 对应 WebGL 里的：**`varying` / `out` / `in`**

这一章解决的问题是：

**顶点着色器算出来的数据，怎么传给片元着色器？**

上一章的红色三角形里，顶点着色器只负责输出位置：

```
return vec4f(pos[vertexIndex], 0.0, 1.0);
```

片元着色器直接返回固定红色：

```
return vec4f(1, 0, 0, 1);
```

所以整个三角形都是红色。

这一章会把它改成：**每个顶点有自己的颜色，然后颜色在三角形内部自动插值，最后形成一个 RGB 渐变三角形。** 教程里明确说明，Inter-stage 变量发生在 vertex shader 和 fragment shader 之间；顶点着色器输出额外值后，这些值默认会在三角形三个点之间插值。

------

先用 WebGL 对比一下。

WebGL / GLSL 里以前会这样写：

```
// vertex shader
attribute vec2 position;
attribute vec4 color;

varying vec4 vColor;

void main() {
  gl_Position = vec4(position, 0.0, 1.0);
  vColor = color;
}
// fragment shader
precision mediump float;

varying vec4 vColor;

void main() {
  gl_FragColor = vColor;
}
```

意思是：

```
顶点 shader 输出 vColor
fragment shader 接收 vColor
GPU 自动把三个顶点颜色插值成每个像素的颜色
```

如果是 WebGL2 / GLSL ES 3.0，会写成：

```
// vertex shader
out vec4 vColor;
// fragment shader
in vec4 vColor;
```

而 WebGPU / WGSL 里不叫 `varying`，而是通过：

```
@location(0)
```

来连接 vertex shader 的输出和 fragment shader 的输入。

------

这一章的 WebGPU 代码核心是这个结构体：

```
struct OurVertexShaderOutput {
  @builtin(position) position: vec4f,
  @location(0) color: vec4f,
};
```

逐行解释：

```
struct OurVertexShaderOutput {
```

声明一个结构体。你可以把它理解成 TypeScript 里的 interface 或 object 类型：

```
type OurVertexShaderOutput = {
  position: Vec4;
  color: Vec4;
}
```

它表示：**顶点着色器这次不仅输出 position，还输出 color。**

------

```
@builtin(position) position: vec4f,
```

这个字段是顶点位置。

`@builtin(position)` 表示这是 GPU 内置语义：顶点最终位置。它不是普通的 Inter-stage 变量。教程中特别指出，`@builtin(position)` 这个字段没有 `location`，它不是普通 inter-stage variable，而是 GPU 管线专门识别的位置输出。

WebGL 对应：

```
gl_Position = vec4(...);
```

WGSL 对应：

```
@builtin(position) position: vec4f
```

------

```
@location(0) color: vec4f,
```

这个字段才是普通的 Inter-stage 变量。

`@location(0)` 的意思是：**把这个变量放在 location 0 这个通道上，从 vertex shader 传给 fragment shader。**

WebGL 对应：

```
varying vec4 vColor;
```

WGSL 对应：

```
@location(0) color: vec4f
```

注意：WebGPU 的连接是靠 **location 编号**，不是靠变量名。教程也明确说，vertex shader 和 fragment shader 之间是通过 location index 连接的。

也就是说，下面这样也能连上：

```
// vertex shader 输出
@location(0) color: vec4f
// fragment shader 输入
@location(0) abc: vec4f
```

即使一个叫 `color`，一个叫 `abc`，只要 location 都是 0，类型匹配，就能连接。

------

然后顶点着色器从原来的：

```
@vertex fn vs(
  @builtin(vertex_index) vertexIndex : u32
) -> @builtin(position) vec4f {
```

改成：

```
@vertex fn vs(
  @builtin(vertex_index) vertexIndex : u32
) -> OurVertexShaderOutput {
```

这表示：顶点着色器以前只返回一个 `vec4f` 位置，现在返回一个结构体。

以前：

```
vertex shader 返回 position
```

现在：

```
vertex shader 返回 {
  position,
  color
}
```

------

接着定义三角形三个顶点的位置：

```
let pos = array(
  vec2f( 0.0,  0.5),
  vec2f(-0.5, -0.5),
  vec2f( 0.5, -0.5)
);
```

这和上一章一样。

三个点分别是：

```
0: 顶部中间
1: 左下角
2: 右下角
```

------

然后新增三个颜色：

```
var color = array<vec4f, 3>(
  vec4f(1, 0, 0, 1), // red
  vec4f(0, 1, 0, 1), // green
  vec4f(0, 0, 1, 1), // blue
);
```

这里声明了一个长度为 3 的 `vec4f` 数组。

```
array<vec4f, 3>
```

表示：

```
数组元素类型：vec4f
数组长度：3
```

三个颜色分别是：

```
vertexIndex = 0 -> 红色
vertexIndex = 1 -> 绿色
vertexIndex = 2 -> 蓝色
```

也就是说，三角形三个顶点分别有不同颜色。

------

然后创建输出对象：

```
var vsOutput: OurVertexShaderOutput;
```

意思是声明一个变量，类型是刚才定义的结构体。

类似 TypeScript：

```
let vsOutput: OurVertexShaderOutput;
```

------

填充 position：

```
vsOutput.position = vec4f(pos[vertexIndex], 0.0, 1.0);
```

这和上一章一样，只是以前直接 `return`，现在先赋值给结构体字段。

相当于：

```
当前顶点的位置 = pos[vertexIndex]
```

------

填充 color：

```
vsOutput.color = color[vertexIndex];
```

这句表示：

```
当前顶点的颜色 = color[vertexIndex]
```

所以：

```
第 0 个顶点：红色
第 1 个顶点：绿色
第 2 个顶点：蓝色
```

------

最后返回整个结构体：

```
return vsOutput;
```

此时 vertex shader 输出了两个东西：

```
position：给 GPU 做光栅化
color：传给 fragment shader
```

------

片元着色器也从原来的：

```
@fragment fn fs() -> @location(0) vec4f {
  return vec4f(1, 0, 0, 1);
}
```

改成：

```
@fragment fn fs(fsInput: OurVertexShaderOutput) -> @location(0) vec4f {
  return fsInput.color;
}
```

这里重点看参数：

```
fsInput: OurVertexShaderOutput
```

意思是：fragment shader 接收 vertex shader 输出的那些数据。

但有一个关键点：fragment shader 收到的 `fsInput.color` 不是某一个顶点的原始颜色，而是 GPU 插值后的颜色。

比如三角形顶部接近红色，左下接近绿色，右下接近蓝色，中间区域会混合成渐变色。

这就是 Inter-stage 变量最核心的作用：

```
顶点 shader 每个顶点输出一个值
GPU 光栅化阶段自动插值
片元 shader 每个像素接收插值后的值
```

教程也说明，这类变量常用于插值纹理坐标和法线；纹理章节会用它传 UV，光照章节会用它传 normal。

------

这一章最重要的知识点是：**插值**。

假设三个顶点颜色是：

```
A 顶点：红色
B 顶点：绿色
C 顶点：蓝色
```

GPU 在三角形内部生成像素时，会根据像素离三个顶点的位置，自动算出混合颜色。

例如三角形中间某个像素可能是：

```
30% 红 + 40% 绿 + 30% 蓝
```

所以 fragment shader 不需要自己手动计算渐变。

你只写：

```
return fsInput.color;
```

它拿到的已经是插值后的颜色。

WebGL 里的 `varying` 也是这样。

------

更精确地说：

```
vertex shader 不是每个像素执行，而是每个顶点执行。
fragment shader 不是每个顶点执行，而是每个片元/像素执行。
```

中间有一个固定功能阶段叫 **rasterization 光栅化**。

流程是：

```
vertex shader 输出 3 个 position
        ↓
GPU 组成三角形
        ↓
光栅化，把三角形变成很多像素
        ↓
对 inter-stage 变量做插值
        ↓
fragment shader 给每个像素算颜色
```

这一章的作用就是让你第一次看到：**vertex shader 和 fragment shader 不是孤立的，它们中间靠 location 变量连接。**

------

你可以把 WebGPU 和 WebGL 对照成这样：

| 概念               | WebGL / GLSL       | WebGPU / WGSL         |
| ------------------ | ------------------ | --------------------- |
| 顶点位置输出       | `gl_Position`      | `@builtin(position)`  |
| 顶点传给片元的数据 | `varying` / `out`  | `@location(n)`        |
| 片元接收数据       | `varying` / `in`   | 同样的 `@location(n)` |
| 连接方式           | 名字或 linker 匹配 | location 编号匹配     |
| 自动插值           | 默认插值           | 默认 perspective 插值 |

这里注意最后一点：WebGPU 的 inter-stage 变量默认会插值；如果你不想插值，需要使用 `@interpolate(flat)`。教程列出默认插值方式是 `perspective`，也可以设置 `linear` 或 `flat`；整数类型的 inter-stage 变量必须设置为 `flat`。

例如：

```
@location(0) @interpolate(flat) id: u32
```

这表示这个 `id` 不做插值。

为什么整数不能插值？因为插值会产生小数，但整数类型无法表示中间值。

比如：

```
顶点 0 的 id = 1
顶点 1 的 id = 5
顶点 2 的 id = 9
```

中间像素如果插值，可能是 `3.7`，这对 `u32` 没意义。所以整数必须 flat。

------

这一章你暂时只需要掌握 4 个点：

第一，**Inter-stage 变量就是 vertex shader 传给 fragment shader 的变量。**

第二，**WebGPU 用 `@location(n)` 连接这些变量。**

第三，**这些变量默认会在三角形内部自动插值。**

第四，**`@builtin(position)` 很特殊，它是内置位置，不是普通 `@location` 变量。**

------

这一章最终你应该能看懂这段代码：

```
struct OurVertexShaderOutput {
  @builtin(position) position: vec4f,
  @location(0) color: vec4f,
};

@vertex fn vs(
  @builtin(vertex_index) vertexIndex : u32
) -> OurVertexShaderOutput {
  let pos = array(
    vec2f( 0.0,  0.5),
    vec2f(-0.5, -0.5),
    vec2f( 0.5, -0.5)
  );

  var color = array<vec4f, 3>(
    vec4f(1, 0, 0, 1),
    vec4f(0, 1, 0, 1),
    vec4f(0, 0, 1, 1),
  );

  var vsOutput: OurVertexShaderOutput;
  vsOutput.position = vec4f(pos[vertexIndex], 0.0, 1.0);
  vsOutput.color = color[vertexIndex];
  return vsOutput;
}

@fragment fn fs(fsInput: OurVertexShaderOutput) -> @location(0) vec4f {
  return fsInput.color;
}
```

用一句话解释它：

**顶点着色器给三个顶点分别输出红、绿、蓝，GPU 自动在三角形内部插值，片元着色器直接返回插值后的颜色，所以得到一个 RGB 渐变三角形。**

