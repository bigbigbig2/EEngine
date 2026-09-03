/**
 * VelocityPass：实现渲染管线中的独立渲染阶段。
 */

import type { FrameGraph } from "../../framegraph/FrameGraph.js";
import type { ResourceId } from "../../framegraph/ResourceHandle.js";
import type { ShadeGPUCommandContext } from "../../framegraph/ShadeGPUCommandContext.js";
import type { GraphicsContext } from "../../gpu/GraphicsContext.js";
import { writeGpuBuffer } from "../../gpu/GpuQueueEvidence.js";
import type { CachedRenderPipelineDescriptor } from "../../gpu/GPUDescriptorCaches.js";
import { textureMipLevelCount } from "../../gpu/GPUTextureContext.js";
import { createNativeTextureView } from "../../gpu/GPUTextureDescriptors.js";
import { VELOCITY_FORMAT, VELOCITY_WGSL } from "../../shaders/velocity.js";
import { resolveTextureView } from "../RenderTargetViews.js";

export type VelocityCameraMatrices = {
  projection_matrix: ArrayLike<number>;
  view_matrix: ArrayLike<number>;
};

export type VelocityInputs = {
  depth: ResourceId;
  meshId: ResourceId;
  triangleId: ResourceId;
  sceneDatabase: ResourceId;
  meshletHeaders: ResourceId;
  meshletData: ResourceId;
  previousPositionOffsets?: ResourceId | null;
  previousPositions?: ResourceId | null;
};

export type VelocityJob = {
  width: number;
  height: number;
  currentCamera: VelocityCameraMatrices;
  previousCamera: VelocityCameraMatrices;
};

export type VelocityOutput = {
  velocity: ResourceId;
};

export class VelocityPass {
  private readonly pipeline: CachedRenderPipelineDescriptor;
  private reprojectionRotationBuffer: GPUBuffer | null = null;
  private inverseCurrentViewProjectionBuffer: GPUBuffer | null = null;
  private previousViewProjectionBuffer: GPUBuffer | null = null;
  private skinningActiveBuffer: GPUBuffer | null = null;
  private readonly reprojectionRotation = new Float32Array(16);
  private readonly inverseCurrentViewProjection = new Float32Array(16);
  private readonly previousViewProjection = new Float32Array(16);
  lastRan = false;

  private readonly device: GPUDevice;

  constructor(graphics: GraphicsContext) {
    if (graphics.device === null) {
      throw new Error("VelocityPass: GraphicsContext has no device");
    }
    this.device = graphics.device;
    this.pipeline = createVelocityPipelineDescriptor();
  }

  init(): void {
    if (this.reprojectionRotationBuffer !== null) return;
    this.reprojectionRotationBuffer = this.createMatrixBuffer(
      "Renderer/Velocity mReprojectionRotation"
    );
    this.inverseCurrentViewProjectionBuffer = this.createMatrixBuffer(
      "Renderer/Velocity mInvViewProjCurrent"
    );
    this.previousViewProjectionBuffer = this.createMatrixBuffer(
      "Renderer/Velocity mViewProjPrevious"
    );
    this.skinningActiveBuffer = this.device.createBuffer({
      label: "Renderer/Velocity skinning_active",
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });
  }

  addToGraph(
    graph: FrameGraph,
    job: VelocityJob,
    inputs: VelocityInputs
  ): VelocityOutput {
    this.init();
    const width = Math.max(1, job.width | 0);
    const height = Math.max(1, job.height | 0);
    const mipLevelCount = textureMipLevelCount(width, height);
    const previousPositionOffsets =
      inputs.previousPositionOffsets ?? inputs.sceneDatabase;
    const previousPositions = inputs.previousPositions ?? inputs.sceneDatabase;
    const skinningActive =
      inputs.previousPositionOffsets != null && inputs.previousPositions != null;
    const output: VelocityOutput = { velocity: -1 };
    const self = this;
    const builder = graph.add(
      "Velocity qk",
      job,
      (data, resources, context) => {
        const command = requireShadeCommandContext(context.encoder);
        const texture = resolveTexture(resources.get(output.velocity), "velocity");
        self.execute(
          command,
          texture,
          data.currentCamera,
          data.previousCamera,
          width,
          height,
          skinningActive,
          {
            depth: resolveTextureView(resources.get(inputs.depth)),
            meshId: resolveTextureView(resources.get(inputs.meshId)),
            triangleId: resolveTextureView(resources.get(inputs.triangleId)),
            sceneDatabase: resolveBuffer(
              resources.get(inputs.sceneDatabase),
              "scene database"
            ),
            meshletHeaders: resolveBuffer(
              resources.get(inputs.meshletHeaders),
              "meshlet headers"
            ),
            meshletData: resolveBuffer(
              resources.get(inputs.meshletData),
              "meshlet data"
            ),
            previousPositionOffsets: resolveBuffer(
              resources.get(previousPositionOffsets),
              "previous-position offsets"
            ),
            previousPositions: resolveBuffer(
              resources.get(previousPositions),
              "previous positions"
            )
          }
        );
      }
    );

    output.velocity = builder.create("velocity", {
      kind: "transient_texture",
      label: "velocity qk",
      width,
      height,
      format: VELOCITY_FORMAT,
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT,
      mipLevelCount
    });
    builder.read(inputs.depth);
    builder.read(inputs.meshId);
    builder.read(inputs.triangleId);
    builder.read(inputs.sceneDatabase);
    builder.read(inputs.meshletHeaders);
    builder.read(inputs.meshletData);
    builder.read(previousPositionOffsets);
    builder.read(previousPositions);
    return output;
  }

  execute(
    command: ShadeGPUCommandContext,
    output: GPUTexture,
    currentCamera: VelocityCameraMatrices,
    previousCamera: VelocityCameraMatrices,
    width: number,
    height: number,
    skinningActive: boolean,
    resources: {
      depth: GPUTextureView;
      meshId: GPUTextureView;
      triangleId: GPUTextureView;
      sceneDatabase: GPUBuffer;
      meshletHeaders: GPUBuffer;
      meshletData: GPUBuffer;
      previousPositionOffsets: GPUBuffer;
      previousPositions: GPUBuffer;
    }
  ): void {
    if (
      this.reprojectionRotationBuffer === null ||
      this.inverseCurrentViewProjectionBuffer === null ||
      this.previousViewProjectionBuffer === null ||
      this.skinningActiveBuffer === null
    ) {
      throw new Error("VelocityPass not initialized");
    }
    prepareVelocityMatrices(
      this.reprojectionRotation,
      this.inverseCurrentViewProjection,
      this.previousViewProjection,
      currentCamera,
      previousCamera,
      width,
      height
    );
    writeGpuBuffer(
      this.device.queue,
      "Velocity/reprojection-rotation",
      this.reprojectionRotationBuffer,
      0,
      this.reprojectionRotation
    );
    writeGpuBuffer(
      this.device.queue,
      "Velocity/inverse-current-view-projection",
      this.inverseCurrentViewProjectionBuffer,
      0,
      this.inverseCurrentViewProjection
    );
    writeGpuBuffer(
      this.device.queue,
      "Velocity/previous-view-projection",
      this.previousViewProjectionBuffer,
      0,
      this.previousViewProjection
    );
    writeGpuBuffer(
      this.device.queue,
      "Velocity/skinning-active",
      this.skinningActiveBuffer,
      0,
      new Uint32Array([skinningActive ? 1 : 0, 0, 0, 0])
    );
    const pass = command.constructRenderPass({
      label: "Velocity qk mip 0",
      pipeline: this.pipeline,
      bindings: [[
        resources.depth,
        resources.meshId,
        resources.triangleId,
        { buffer: this.reprojectionRotationBuffer },
        { buffer: this.inverseCurrentViewProjectionBuffer },
        { buffer: this.previousViewProjectionBuffer },
        { buffer: this.skinningActiveBuffer },
        { buffer: resources.sceneDatabase },
        { buffer: resources.meshletHeaders },
        { buffer: resources.meshletData },
        { buffer: resources.previousPositionOffsets },
        { buffer: resources.previousPositions }
      ]],
      colorAttachments: [
        {
          view: createNativeTextureView(output, {
            baseMipLevel: 0,
            mipLevelCount: 1
          }),
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
          loadOp: "clear",
          storeOp: "store"
        }
      ]
    });
    pass.draw(3, 1, 0, 0);
    pass.end();
    this.lastRan = true;
  }

  private createMatrixBuffer(label: string): GPUBuffer {
    return this.device.createBuffer({
      label,
      size: 64,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });
  }

  destroy(): void {
    this.reprojectionRotationBuffer?.destroy();
    this.inverseCurrentViewProjectionBuffer?.destroy();
    this.previousViewProjectionBuffer?.destroy();
    this.skinningActiveBuffer?.destroy();
    this.reprojectionRotationBuffer = null;
    this.inverseCurrentViewProjectionBuffer = null;
    this.previousViewProjectionBuffer = null;
    this.skinningActiveBuffer = null;
  }
}

function createVelocityPipelineDescriptor(): CachedRenderPipelineDescriptor {
  const label = "Renderer/Velocity qk";
  const module = { label, code: VELOCITY_WGSL };
  return {
    label,
    layout: {
      label: `${label} layout`,
      bindGroupLayouts: [createVelocityGroupLayout()]
    },
    vertex: { module, entryPoint: "vs_main" },
    fragment: {
      module,
      entryPoint: "fs_main",
      targets: [{ format: VELOCITY_FORMAT }]
    },
    primitive: { topology: "triangle-list", cullMode: "none" }
  };
}

function createVelocityGroupLayout(): GPUBindGroupLayoutDescriptor {
  const fragment = GPUShaderStage.FRAGMENT;
  return {
    label: "Renderer/Velocity qk group0",
    entries: [
      { binding: 0, visibility: fragment, texture: { sampleType: "unfilterable-float", viewDimension: "2d" } },
      { binding: 1, visibility: fragment, texture: { sampleType: "uint", viewDimension: "2d" } },
      { binding: 2, visibility: fragment, texture: { sampleType: "uint", viewDimension: "2d" } },
      { binding: 3, visibility: fragment, buffer: { type: "uniform" } },
      { binding: 4, visibility: fragment, buffer: { type: "uniform" } },
      { binding: 5, visibility: fragment, buffer: { type: "uniform" } },
      { binding: 6, visibility: fragment, buffer: { type: "uniform" } },
      { binding: 7, visibility: fragment, buffer: { type: "read-only-storage" } },
      { binding: 8, visibility: fragment, buffer: { type: "read-only-storage" } },
      { binding: 9, visibility: fragment, buffer: { type: "read-only-storage" } },
      { binding: 10, visibility: fragment, buffer: { type: "read-only-storage" } },
      { binding: 11, visibility: fragment, buffer: { type: "read-only-storage" } }
    ]
  };
}

function requireShadeCommandContext(value: unknown): ShadeGPUCommandContext {
  if (
    value &&
    typeof value === "object" &&
    "isGPUCommandContext" in value &&
    (value as { isGPUCommandContext?: unknown }).isGPUCommandContext === true &&
    "constructRenderPass" in value
  ) {
    return value as ShadeGPUCommandContext;
  }
  throw new Error("VelocityPass: cached qk requires ShadeGPUCommandContext");
}

export function prepareVelocityMatrices(
  reprojectionRotationOut: Float32Array,
  inverseCurrentViewProjectionOut: Float32Array,
  previousViewProjectionOut: Float32Array,
  currentCamera: VelocityCameraMatrices,
  previousCamera: VelocityCameraMatrices,
  width: number,
  height: number
): void {
  const currentViewProjection = multiplyMat4d(
    currentCamera.projection_matrix,
    currentCamera.view_matrix
  );
  const inverseCurrent = invertMat4d(currentViewProjection);
  const previousViewProjection = multiplyMat4d(
    previousCamera.projection_matrix,
    previousCamera.view_matrix
  );
  inverseCurrentViewProjectionOut.set(inverseCurrent);
  previousViewProjectionOut.set(previousViewProjection);

  const currentRotationView = Float64Array.from(currentCamera.view_matrix);
  currentRotationView[12] = 0;
  currentRotationView[13] = 0;
  currentRotationView[14] = 0;
  const previousRotationView = Float64Array.from(previousCamera.view_matrix);
  previousRotationView[12] = 0;
  previousRotationView[13] = 0;
  previousRotationView[14] = 0;
  const currentRotationViewProjection = multiplyMat4d(
    currentCamera.projection_matrix,
    currentRotationView
  );
  const previousRotationViewProjection = multiplyMat4d(
    previousCamera.projection_matrix,
    previousRotationView
  );
  const ndcReprojection = multiplyMat4d(
    previousRotationViewProjection,
    invertMat4d(currentRotationViewProjection)
  );
  const halfWidth = width / 2;
  const halfHeight = height / 2;
  const pixelFromNdc = new Float64Array([
    halfWidth, 0, 0, 0,
    0, -halfHeight, 0, 0,
    0, 0, 1, 0,
    halfWidth, halfHeight, 0, 1
  ]);
  const ndcFromPixel = new Float64Array([
    2 / width, 0, 0, 0,
    0, -2 / height, 0, 0,
    0, 0, 1, 0,
    -1, 1, 0, 1
  ]);
  reprojectionRotationOut.set(
    multiplyMat4d(multiplyMat4d(pixelFromNdc, ndcReprojection), ndcFromPixel)
  );
}

function multiplyMat4d(a: ArrayLike<number>, b: ArrayLike<number>): Float64Array {
  const out = new Float64Array(16);
  for (let column = 0; column < 4; column++) {
    const offset = column * 4;
    const b0 = b[offset] ?? 0;
    const b1 = b[offset + 1] ?? 0;
    const b2 = b[offset + 2] ?? 0;
    const b3 = b[offset + 3] ?? 0;
    out[offset] = b0 * (a[0] ?? 0) + b1 * (a[4] ?? 0) + b2 * (a[8] ?? 0) + b3 * (a[12] ?? 0);
    out[offset + 1] = b0 * (a[1] ?? 0) + b1 * (a[5] ?? 0) + b2 * (a[9] ?? 0) + b3 * (a[13] ?? 0);
    out[offset + 2] = b0 * (a[2] ?? 0) + b1 * (a[6] ?? 0) + b2 * (a[10] ?? 0) + b3 * (a[14] ?? 0);
    out[offset + 3] = b0 * (a[3] ?? 0) + b1 * (a[7] ?? 0) + b2 * (a[11] ?? 0) + b3 * (a[15] ?? 0);
  }
  return out;
}

function invertMat4d(a: ArrayLike<number>): Float64Array {
  const a00 = a[0] ?? 0, a01 = a[1] ?? 0, a02 = a[2] ?? 0, a03 = a[3] ?? 0;
  const a10 = a[4] ?? 0, a11 = a[5] ?? 0, a12 = a[6] ?? 0, a13 = a[7] ?? 0;
  const a20 = a[8] ?? 0, a21 = a[9] ?? 0, a22 = a[10] ?? 0, a23 = a[11] ?? 0;
  const a30 = a[12] ?? 0, a31 = a[13] ?? 0, a32 = a[14] ?? 0, a33 = a[15] ?? 0;
  const b00 = a00 * a11 - a01 * a10;
  const b01 = a00 * a12 - a02 * a10;
  const b02 = a00 * a13 - a03 * a10;
  const b03 = a01 * a12 - a02 * a11;
  const b04 = a01 * a13 - a03 * a11;
  const b05 = a02 * a13 - a03 * a12;
  const b06 = a20 * a31 - a21 * a30;
  const b07 = a20 * a32 - a22 * a30;
  const b08 = a20 * a33 - a23 * a30;
  const b09 = a21 * a32 - a22 * a31;
  const b10 = a21 * a33 - a23 * a31;
  const b11 = a22 * a33 - a23 * a32;
  let determinant =
    b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  if (Math.abs(determinant) < 1e-15) {
    throw new Error("VelocityPass: camera matrix is singular");
  }
  determinant = 1 / determinant;
  return new Float64Array([
    (a11 * b11 - a12 * b10 + a13 * b09) * determinant,
    (a02 * b10 - a01 * b11 - a03 * b09) * determinant,
    (a31 * b05 - a32 * b04 + a33 * b03) * determinant,
    (a22 * b04 - a21 * b05 - a23 * b03) * determinant,
    (a12 * b08 - a10 * b11 - a13 * b07) * determinant,
    (a00 * b11 - a02 * b08 + a03 * b07) * determinant,
    (a32 * b02 - a30 * b05 - a33 * b01) * determinant,
    (a20 * b05 - a22 * b02 + a23 * b01) * determinant,
    (a10 * b10 - a11 * b08 + a13 * b06) * determinant,
    (a01 * b08 - a00 * b10 - a03 * b06) * determinant,
    (a30 * b04 - a31 * b02 + a33 * b00) * determinant,
    (a21 * b02 - a20 * b04 - a23 * b00) * determinant,
    (a11 * b07 - a10 * b09 - a12 * b06) * determinant,
    (a00 * b09 - a01 * b07 + a02 * b06) * determinant,
    (a31 * b01 - a30 * b03 - a32 * b00) * determinant,
    (a20 * b03 - a21 * b01 + a22 * b00) * determinant
  ]);
}

function resolveTexture(resource: unknown, label: string): GPUTexture {
  if (
    resource &&
    typeof resource === "object" &&
    "createView" in resource &&
    typeof (resource as { createView?: unknown }).createView === "function"
  ) {
    return resource as GPUTexture;
  }
  throw new Error(`VelocityPass: missing ${label} texture`);
}

function resolveBuffer(resource: unknown, label: string): GPUBuffer {
  if (resource && typeof resource === "object") {
    if ("size" in resource && "usage" in resource) return resource as GPUBuffer;
    if ("buffer" in resource) {
      const buffer = (resource as { buffer?: unknown }).buffer;
      if (buffer && typeof buffer === "object") return buffer as GPUBuffer;
    }
  }
  throw new Error(`VelocityPass: missing ${label} buffer`);
}
