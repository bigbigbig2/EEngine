import { encodeVisibilityKey } from "../gpu/GpuVisibilityKeyAbi.js";
import { PACKED_MATERIAL_CLASS_DEPTH_WGSL } from "../shaders/packed_material_class_depth.js";
import type { MaterialResolveBackend } from "./MaterialResolveBackend.js";

export interface MaterialResolveBackendSelection {
  readonly backend: MaterialResolveBackend;
  readonly source: "benchmark-override" | "adapter-probe" | "probe-unavailable";
  readonly reason: string;
}

let benchmarkOverride: MaterialResolveBackend | null = null;

/** Internal Rendering Lab seam. This module is deliberately not exported by src/index.ts. */
export function setMaterialResolveBackendBenchmarkOverride(
  backend: MaterialResolveBackend | null
): void {
  benchmarkOverride = backend;
}

/** Validate the exact depth values and fixed-function `equal` path once per device. */
export async function selectMaterialResolveBackend(
  device: GPUDevice
): Promise<MaterialResolveBackendSelection> {
  if (benchmarkOverride !== null) {
    return Object.freeze({
      backend: benchmarkOverride,
      source: "benchmark-override",
      reason: `Rendering Lab requested ${benchmarkOverride}`
    });
  }
  if (typeof device.pushErrorScope !== "function" ||
      typeof device.createTexture !== "function" ||
      typeof device.createRenderPipeline !== "function") {
    return Object.freeze({
      backend: "class-depth",
      source: "probe-unavailable",
      reason: "GPU depth-equal probe unavailable on the injected device"
    });
  }

  let visibility: GPUTexture | null = null;
  let classDepth: GPUTexture | null = null;
  let result: GPUTexture | null = null;
  let readback: GPUBuffer | null = null;
  let errorScopePopped = false;
  device.pushErrorScope("validation");
  try {
    visibility = device.createTexture({
      label: "MaterialClassDepth probe/visibility",
      size: { width: 7, height: 1 },
      format: "r32uint",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST
    });
    classDepth = device.createTexture({
      label: "MaterialClassDepth probe/depth",
      size: { width: 7, height: 1 },
      format: "depth32float",
      usage: GPUTextureUsage.RENDER_ATTACHMENT
    });
    result = device.createTexture({
      label: "MaterialClassDepth probe/result",
      size: { width: 7, height: 1 },
      format: "rgba8uint",
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC
    });
    readback = device.createBuffer({
      label: "MaterialClassDepth probe/readback",
      size: 256,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
    });
    device.queue.writeTexture(
      { texture: visibility },
      new Uint32Array(Array.from({ length: 7 }, (_, kernelClass) =>
        encodeVisibilityKey(kernelClass, kernelClass))),
      { bytesPerRow: 28, rowsPerImage: 1 },
      { width: 7, height: 1 }
    );

    const classModule = device.createShaderModule({
      label: "MaterialClassDepth probe/classify",
      code: PACKED_MATERIAL_CLASS_DEPTH_WGSL
    });
    const classPipeline = device.createRenderPipeline({
      label: "MaterialClassDepth probe/classify",
      layout: "auto",
      vertex: { module: classModule, entryPoint: "packed_material_class_depth_vs" },
      fragment: { module: classModule, entryPoint: "packed_material_class_depth_fs", targets: [] },
      primitive: { topology: "triangle-list" },
      depthStencil: { format: "depth32float", depthWriteEnabled: true, depthCompare: "greater" }
    });
    const classGroup = device.createBindGroup({
      label: "MaterialClassDepth probe/visibility",
      layout: classPipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: visibility.createView() }]
    });
    const encoder = device.createCommandEncoder({ label: "MaterialClassDepth probe" });
    const classify = encoder.beginRenderPass({
      label: "MaterialClassDepth probe/classify",
      colorAttachments: [],
      depthStencilAttachment: {
        view: classDepth.createView(),
        depthClearValue: 0,
        depthLoadOp: "clear",
        depthStoreOp: "store"
      }
    });
    classify.setPipeline(classPipeline);
    classify.setBindGroup(0, classGroup);
    classify.draw(3);
    classify.end();

    const verify = encoder.beginRenderPass({
      label: "MaterialClassDepth probe/verify equal",
      colorAttachments: [{
        view: result.createView(),
        clearValue: { r: 0, g: 0, b: 0, a: 0 },
        loadOp: "clear",
        storeOp: "store"
      }],
      depthStencilAttachment: {
        view: classDepth.createView(),
        depthLoadOp: "load",
        depthStoreOp: "store",
        depthReadOnly: true
      }
    });
    for (let kernelClass = 0; kernelClass < 7; kernelClass++) {
      verify.setPipeline(createVerifyPipeline(device, kernelClass));
      verify.draw(3);
    }
    verify.end();
    encoder.copyTextureToBuffer(
      { texture: result },
      { buffer: readback, bytesPerRow: 256, rowsPerImage: 1 },
      { width: 7, height: 1 }
    );
    device.queue.submit([encoder.finish()]);
    await readback.mapAsync(GPUMapMode.READ);
    const bytes = new Uint8Array(readback.getMappedRange());
    const matches = Array.from({ length: 7 }, (_, index) => bytes[index * 4] === index + 1)
      .every(Boolean);
    readback.unmap();
    const validationError = await device.popErrorScope();
    errorScopePopped = true;
    if (!matches || validationError !== null) {
      return fallback(validationError?.message ?? "depth32float equal probe produced mismatched pixels");
    }
    return Object.freeze({
      backend: "class-depth",
      source: "adapter-probe",
      reason: "depth32float class values and fixed-function equal comparison passed"
    });
  } catch (error) {
    const validationError = errorScopePopped
      ? null
      : await device.popErrorScope().catch(() => null);
    errorScopePopped = true;
    return fallback(validationError?.message ?? (error instanceof Error ? error.message : String(error)));
  } finally {
    if (!errorScopePopped) await device.popErrorScope().catch(() => null);
    readback?.destroy();
    result?.destroy();
    classDepth?.destroy();
    visibility?.destroy();
  }
}

function fallback(reason: string): MaterialResolveBackendSelection {
  return Object.freeze({ backend: "class-discard", source: "adapter-probe", reason });
}

function createVerifyPipeline(device: GPUDevice, kernelClass: number): GPURenderPipeline {
  const depth = (kernelClass + 1) / 8;
  const module = device.createShaderModule({
    label: `MaterialClassDepth probe/verify class ${kernelClass}`,
    code: /* wgsl */ `
@vertex
fn vs(@builtin(vertex_index) vertex_index: u32) -> @builtin(position) vec4f {
  var positions = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(positions[vertex_index], ${depth}, 1.0);
}
@fragment
fn fs() -> @location(0) vec4u {
  return vec4u(${kernelClass + 1}u, 0u, 0u, 255u);
}`
  });
  return device.createRenderPipeline({
    label: `MaterialClassDepth probe/verify class ${kernelClass}`,
    layout: "auto",
    vertex: { module, entryPoint: "vs" },
    fragment: { module, entryPoint: "fs", targets: [{ format: "rgba8uint" }] },
    primitive: { topology: "triangle-list" },
    depthStencil: { format: "depth32float", depthWriteEnabled: false, depthCompare: "equal" }
  });
}
