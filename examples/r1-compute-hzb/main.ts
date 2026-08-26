import {
  HZB_FROM_DEPTH_COMPUTE_WGSL,
  HZB_REDUCE_COMPUTE_WGSL,
  HZB_WORKGROUP_SIZE
} from "../../OEngine/src/shaders/hzb_reduce.ts";
import { buildHzbReference } from "../../OEngine/src/render/HzbReference.ts";

const SOURCE_WIDTH = 9;
const SOURCE_HEIGHT = 7;
const HZB_WIDTH = SOURCE_WIDTH >> 1;
const HZB_HEIGHT = SOURCE_HEIGHT >> 1;

const status = requiredElement<HTMLElement>("status");
const summary = requiredElement<HTMLElement>("summary");
const result = requiredElement<HTMLElement>("result");

void run().catch((error: unknown) => {
  status.textContent = "验证失败";
  status.className = "error";
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  result.textContent = message;
  console.error(error);
});

async function run(): Promise<void> {
  if (!navigator.gpu) throw new Error("当前浏览器没有 WebGPU");
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
  if (!adapter) throw new Error("没有可用的 WebGPU adapter");
  const device = await adapter.requestDevice();
  const uncaptured: string[] = [];
  device.addEventListener("uncapturederror", (event) => {
    uncaptured.push(event.error.message);
  });
  device.pushErrorScope("validation");

  const depth = device.createTexture({
    label: "R1-C/prototype-depth-9x7",
    size: [SOURCE_WIDTH, SOURCE_HEIGHT],
    format: "depth32float",
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING
  });
  const mipCount = Math.floor(Math.log2(Math.max(HZB_WIDTH, HZB_HEIGHT))) + 1;
  const hzb = device.createTexture({
    label: "R1-C/prototype-hzb",
    size: [HZB_WIDTH, HZB_HEIGHT],
    mipLevelCount: mipCount,
    format: "rg16float",
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC
  });
  const region = device.createBuffer({
    label: "R1-C/source-region",
    size: 16,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
  });
  device.queue.writeBuffer(region, 0, new Uint32Array([0, 0, SOURCE_WIDTH, SOURCE_HEIGHT]));

  const depthPipeline = device.createRenderPipeline({
    label: "R1-C/fixed-depth",
    layout: "auto",
    vertex: { module: device.createShaderModule({ code: DEPTH_WGSL }), entryPoint: "vs_main" },
    fragment: { module: device.createShaderModule({ code: DEPTH_WGSL }), entryPoint: "fs_main", targets: [] },
    primitive: { topology: "triangle-list" },
    depthStencil: { format: "depth32float", depthWriteEnabled: true, depthCompare: "always" }
  });
  const fromDepth = device.createComputePipeline({
    label: "R1-C/from-depth",
    layout: "auto",
    compute: {
      module: device.createShaderModule({ code: HZB_FROM_DEPTH_COMPUTE_WGSL }),
      entryPoint: "main"
    }
  });
  const reduce = device.createComputePipeline({
    label: "R1-C/reduce",
    layout: "auto",
    compute: {
      module: device.createShaderModule({ code: HZB_REDUCE_COMPUTE_WGSL }),
      entryPoint: "main"
    }
  });

  const readback = device.createBuffer({
    label: "R1-C/final-mip-readback",
    size: 256,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
  });
  const encoder = device.createCommandEncoder({ label: "R1-C/prototype" });
  const depthPass = encoder.beginRenderPass({
    label: "R1-C/generate-depth",
    colorAttachments: [],
    depthStencilAttachment: {
      view: depth.createView(),
      depthClearValue: 0,
      depthLoadOp: "clear",
      depthStoreOp: "store"
    }
  });
  depthPass.setPipeline(depthPipeline);
  depthPass.draw(3);
  depthPass.end();

  const compute = encoder.beginComputePass({ label: "R1-C/compute-pyramid" });
  compute.setPipeline(fromDepth);
  compute.setBindGroup(0, device.createBindGroup({
    layout: fromDepth.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: depth.createView() },
      { binding: 1, resource: hzb.createView({ baseMipLevel: 0, mipLevelCount: 1 }) },
      { binding: 2, resource: { buffer: region } }
    ]
  }));
  dispatch(compute, HZB_WIDTH, HZB_HEIGHT);
  compute.setPipeline(reduce);
  let width = HZB_WIDTH;
  let height = HZB_HEIGHT;
  for (let mip = 1; mip < mipCount; mip++) {
    compute.setBindGroup(0, device.createBindGroup({
      layout: reduce.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: hzb.createView({ baseMipLevel: mip - 1, mipLevelCount: 1 }) },
        { binding: 1, resource: hzb.createView({ baseMipLevel: mip, mipLevelCount: 1 }) }
      ]
    }));
    width = Math.max(1, width >> 1);
    height = Math.max(1, height >> 1);
    dispatch(compute, width, height);
  }
  compute.end();
  encoder.copyTextureToBuffer(
    { texture: hzb, mipLevel: mipCount - 1 },
    { buffer: readback, bytesPerRow: 256, rowsPerImage: 1 },
    [1, 1, 1]
  );
  device.queue.submit([encoder.finish()]);
  await device.queue.onSubmittedWorkDone();
  const validation = await device.popErrorScope();
  await readback.mapAsync(GPUMapMode.READ);
  const bytes = new Uint16Array(readback.getMappedRange().slice(0, 4));
  const actual = [float16ToNumber(bytes[0]!), float16ToNumber(bytes[1]!)];
  readback.unmap();

  const source = new Float32Array(SOURCE_WIDTH * SOURCE_HEIGHT);
  for (let y = 0; y < SOURCE_HEIGHT; y++) {
    for (let x = 0; x < SOURCE_WIDTH; x++) {
      source[y * SOURCE_WIDTH + x] = (x + 0.5 + y + 0.5) / (SOURCE_WIDTH + SOURCE_HEIGHT);
    }
  }
  const expectedLevel = buildHzbReference(source, SOURCE_WIDTH, SOURCE_HEIGHT).at(-1)!;
  const expected = [expectedLevel.minMax[0]!, expectedLevel.minMax[1]!];
  const maxError = Math.max(Math.abs(actual[0]! - expected[0]!), Math.abs(actual[1]! - expected[1]!));
  const passed = validation === null && uncaptured.length === 0 && maxError < 0.001;
  const artifact = {
    passed,
    adapter: adapter.info,
    format: "rg16float",
    sourceSize: [SOURCE_WIDTH, SOURCE_HEIGHT],
    hzbSize: [HZB_WIDTH, HZB_HEIGHT],
    mipCount,
    computePasses: 1,
    dispatches: mipCount,
    workgroupSize: HZB_WORKGROUP_SIZE,
    actualFinalMinMax: actual,
    expectedFinalMinMax: expected,
    maxError,
    validationError: validation?.message ?? null,
    uncapturedErrors: uncaptured
  };
  status.textContent = passed ? "验证通过" : "验证失败";
  status.className = passed ? "ok" : "error";
  summary.textContent = `1 Compute Pass · ${mipCount} dispatches · max error ${maxError.toExponential(2)}`;
  result.textContent = JSON.stringify(artifact, null, 2);
  if (!passed) throw new Error("Compute HZB prototype did not pass its numerical/validation gate");
}

function dispatch(pass: GPUComputePassEncoder, width: number, height: number): void {
  pass.dispatchWorkgroups(
    Math.ceil(width / HZB_WORKGROUP_SIZE),
    Math.ceil(height / HZB_WORKGROUP_SIZE),
    1
  );
}

function float16ToNumber(value: number): number {
  const sign = (value & 0x8000) === 0 ? 1 : -1;
  const exponent = (value >>> 10) & 0x1f;
  const fraction = value & 0x03ff;
  if (exponent === 0) return sign * 2 ** -14 * (fraction / 1024);
  if (exponent === 0x1f) return fraction === 0 ? sign * Infinity : Number.NaN;
  return sign * 2 ** (exponent - 15) * (1 + fraction / 1024);
}

function requiredElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing #${id}`);
  return element as T;
}

const DEPTH_WGSL = /* wgsl */ `
const POSITIONS = array(vec2f(-1, -1), vec2f(3, -1), vec2f(-1, 3));
@vertex fn vs_main(@builtin(vertex_index) index: u32) -> @builtin(position) vec4f {
  return vec4f(POSITIONS[index], 0, 1);
}
@fragment fn fs_main(@builtin(position) position: vec4f) -> @builtin(frag_depth) f32 {
  return (position.x + position.y) / ${SOURCE_WIDTH + SOURCE_HEIGHT}.0;
}
`;
