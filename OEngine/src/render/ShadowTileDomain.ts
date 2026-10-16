import { PreparedComputePipeline } from "../gpu/PreparedPipeline.js";
import type { ShadeGPUCommandContext } from "../framegraph/ShadeGPUCommandContext.js";
import { SHADOW_TILE_BUILD_WGSL, SHADOW_TILE_DOMAIN_BYTES } from "../shaders/shadow_tile_domain.js";
import { VSM_VIRTUAL_PAGES_PER_AXIS, VSM_PAGE_SIZE, VSM_BORDER } from "./vsm/VsmCapabilities.js";
import type { VsmDirectionalFrameConstants } from "./vsm/VsmProjection.js";
import { VSM_PAGE_WORK_WORDS, vsmEntriesPerClipLevel } from "./vsm/VsmPageState.js";
import type { ResourceAccounting, ResourceHandle } from "../debug/profiling/ResourceAccounting.js";

const tilePipelines = new WeakMap<GPUDevice, PreparedComputePipeline>();
function obtainTilePipeline(device: GPUDevice): PreparedComputePipeline {
  let cached = tilePipelines.get(device);
  if (cached) {
    return cached;
  }
  const pipeline = new PreparedComputePipeline(device, {
    label: "Shadow geometry/build tile domains",
    layout: "auto",
    compute: {
      module: device.createShaderModule({ label: "Shadow tile domains", code: SHADOW_TILE_BUILD_WGSL }),
      entryPoint: "main",
    },
  });

  tilePipelines.set(device, pipeline);
  return pipeline;
}

/** Frame-local GPU demand/selected domains, rebuilt inside the ordinary frame. */
export class ShadowTileDomain {
  static async preparePipelines(device: GPUDevice): Promise<void> {
    await obtainTilePipeline(device).prepare();
  }

  async preparePipelines(): Promise<void> {
    await Promise.all([this.pipeline.prepare()]);
  }

  readonly buffer: GPUBuffer;
  private readonly constants: GPUBuffer;
  private readonly pipeline: PreparedComputePipeline;
  private readonly groups = new WeakMap<GPUBuffer, WeakMap<GPUBuffer, GPUBindGroup>>();
  private readonly header = new ArrayBuffer(256);
  private readonly handles: ResourceHandle[] = [];
  private destroyed = false;

  constructor(
    private readonly device: GPUDevice,
    private readonly accounting?: ResourceAccounting
  ) {
    if (
      device.limits.maxStorageBufferBindingSize < SHADOW_TILE_DOMAIN_BYTES ||
      device.limits.maxBufferSize < SHADOW_TILE_DOMAIN_BYTES ||
      device.limits.maxUniformBufferBindingSize < 176 ||
      device.limits.minStorageBufferOffsetAlignment > 256 ||
      device.limits.maxBindingsPerBindGroup < 16 ||
      device.limits.maxBindGroups < 3
    ) {
      throw new RangeError("Shadow tile domain exceeds negotiated device limits");
    }
    this.buffer = device.createBuffer({
      label: "Shadow geometry/requested and selected tile domains",
      size: SHADOW_TILE_DOMAIN_BYTES,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC
    });
    this.constants = device.createBuffer({
      label: "Shadow geometry/tile domain constants",
      size: 176,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.pipeline = obtainTilePipeline(device);
    for (const buffer of [this.buffer, this.constants]) {
      if (accounting)
        this.handles.push(
          accounting.created(
            {
              kind: "buffer",
              category: "transient",
              owner: "ShadowGeometryWork",
              bytes: buffer.size,
              label: buffer.label
            },
            buffer
          )
        );
    }
  }

  encode(
    command: ShadeGPUCommandContext,
    frame: VsmDirectionalFrameConstants,
    requested: GPUBuffer,
    allocation: GPUBuffer
  ): void {
    const bytes = this.header;
    new Uint8Array(bytes).fill(0);
    new Float32Array(bytes).set(frame.lightView);
    frame.clipOriginExtent.forEach((clip, level) => new Float32Array(bytes).set(clip, 16 + level * 4));
    const perLevel = vsmEntriesPerClipLevel(VSM_VIRTUAL_PAGES_PER_AXIS);
    new Uint32Array(bytes).set(
      [perLevel * frame.clipOriginExtent.length, VSM_VIRTUAL_PAGES_PER_AXIS, VSM_PAGE_SIZE, VSM_BORDER],
      40
    );
    command.writeBuffer(this.constants, 0, bytes, 0, 176);
    command.writeBuffer(this.buffer, 0, bytes, 0, 256);
    command.clearBuffer(this.buffer, 256, SHADOW_TILE_DOMAIN_BYTES - 256);
    let byAllocation = this.groups.get(requested);
    if (byAllocation === undefined) {
      byAllocation = new WeakMap();
      this.groups.set(requested, byAllocation);
    }
    let group = byAllocation.get(allocation);
    if (group === undefined) {
      group = this.device.createBindGroup({
        label: "Shadow geometry/tile domain sources",
        layout: this.pipeline.requirePrepared().getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: this.constants } },
          { binding: 1, resource: { buffer: requested } },
          { binding: 2, resource: { buffer: allocation } },
          { binding: 3, resource: { buffer: this.buffer, offset: 256 } }
        ]
      });
      byAllocation.set(allocation, group);
    }
    const pass = command.beginComputePass({ label: "Shadow geometry/build tile domains" });
    pass.setPipeline(this.pipeline.requirePrepared());
    pass.setBindGroup(0, group);
    pass.dispatchWorkgroups(
      Math.ceil(Math.max(requested.size / 4, (allocation.size - 16) / (VSM_PAGE_WORK_WORDS * 4)) / 64)
    );
    pass.end();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.buffer.destroy();
    this.constants.destroy();
    for (const handle of this.handles) this.accounting!.destroyed(handle);
  }
}
