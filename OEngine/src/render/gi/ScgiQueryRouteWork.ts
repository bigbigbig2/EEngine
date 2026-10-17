import { geometryQueryPipelines } from "../../gpu/GeometryQueryPipelines.js";
import type { ShadeGPUCommandContext } from "../../framegraph/ShadeGPUCommandContext.js";
import type { ScgiQueryScene } from "./ScgiQueryScene.js";
import type { ScgiQueryArenaRoute } from "./ScgiQueryArena.js";
import type { ScgiQueryRayCount } from "./ScgiQueryRayCount.js";

/** One reusable dense route list per batch, not ray ? asset or ray ? arena.
 * Routing is conservative against the complete route TLAS root. A workgroup
 * reserves its accepted prefix with one global atomic. Encoder order protects
 * the shared list until its traversal has finished. */
export class ScgiQueryRouteWork {
  private constructor(
    readonly buffer: GPUBuffer,
    readonly indirect: GPUBuffer,
    readonly counters: GPUBuffer | undefined,
    private readonly pipeline: GPUComputePipeline,
    private readonly finalize: GPUComputePipeline,
    private readonly groups: ReadonlyMap<ScgiQueryArenaRoute, GPUBindGroup>,
    private readonly rayWork: ScgiQueryRayCount,
  ) {}

  static async create(
    device: GPUDevice,
    scene: ScgiQueryScene,
    batch: GPUBuffer,
    capacity: number,
    resultOffset: number,
    rayWork: ScgiQueryRayCount,
    anyHit: boolean,
    diagnostics: boolean,
  ): Promise<ScgiQueryRouteWork> {
    const bytes = 32 + capacity * 4;
    if (bytes > Math.min(device.limits.maxBufferSize, device.limits.maxStorageBufferBindingSize)) {
      throw new RangeError("Complete query route list exceeds negotiated capacity");
    }
    const entries: GPUBindGroupLayoutEntry[] = [0, 1, 2, 3].map((binding) => ({
      binding,
      visibility: GPUShaderStage.COMPUTE,
      buffer: { type: binding === 3 ? "storage" : "read-only-storage" },
    }));
    const cache = geometryQueryPipelines(device);
    const layout = cache.layouts.obtainBindGroupLayout({ entries });
    const code = /* wgsl */ `
@group(0) @binding(0) var<storage, read> batch: array<u32>;
@group(0) @binding(1) var<storage, read> tree: array<u32>;
@group(0) @binding(2) var<storage, read> ray_count: array<u32>;
@group(0) @binding(3) var<storage, read_write> work: array<atomic<u32>>;
var<workgroup> prefix: array<u32, 128>;
var<workgroup> reservation: u32;
fn selected(ray: u32) -> bool {
  if (ray >= ray_count[0]) { return false; }
  let result = ${resultOffset / 4}u + ray * 8u;
  let status = batch[result + 3u];
  if (status > 1u || (${anyHit} && status == 0u)) { return false; }
  // Corrupted AS must reach traversal and become fault, never a false miss.
  if (tree[2] != 0u) { return true; }
  if (tree[0] == 0u) { return false; }
  let root = tree[1];
  if (root >= tree[0] * 2u - 1u) { return true; }
  // All route trees use the same negotiated scene plan.
  let at = ${scene.arenas[0]!.plan.hierarchy.ranges.nodes!.offset / 4}u + root * 16u;
  var near = bitcast<f32>(batch[ray * 12u + 3u]);
  var far = bitcast<f32>(batch[result]);
  for (var axis = 0u; axis < 3u; axis++) {
    let low = min(bitcast<f32>(tree[at + axis]), bitcast<f32>(tree[at + 8u + axis]));
    let high = max(bitcast<f32>(tree[at + 4u + axis]), bitcast<f32>(tree[at + 12u + axis]));
    let origin = bitcast<f32>(batch[ray * 12u + axis]);
    let direction = bitcast<f32>(batch[ray * 12u + 4u + axis]);
    if (direction == 0.0) {
      if (origin < low || origin > high) { return false; }
    } else {
      let a = (low - origin) / direction;
      let b = (high - origin) / direction;
      near = max(near, min(a, b));
      far = min(far, max(a, b));
      if (near > far) { return false; }
    }
  }
  return near <= far;
}
@compute @workgroup_size(128)
fn compact(@builtin(local_invocation_index) lane: u32, @builtin(workgroup_id) group: vec3u) {
  let ray = group.x * 128u + lane;
  let keep = u32(selected(ray));
  prefix[lane] = keep;
  workgroupBarrier();
  for (var width = 1u; width < 128u; width <<= 1u) {
    var add = 0u;
    if (lane >= width) { add = prefix[lane - width]; }
    workgroupBarrier();
    prefix[lane] += add;
    workgroupBarrier();
  }
  if (lane == 0u) { reservation = atomicAdd(&work[0], prefix[127]); }
  workgroupBarrier();
  if (keep != 0u) { atomicStore(&work[8u + reservation + prefix[lane] - 1u], ray); }
}
@compute @workgroup_size(1)
fn finalize() {
  let count = atomicLoad(&work[0]);
  // Each invocation contributes at most one ray, hence count <= active <= capacity.
  atomicStore(&work[4], (count + 63u) / 64u);
  atomicStore(&work[5], 1u);
  atomicStore(&work[6], 1u);
  atomicStore(&work[7], ray_count[0]);
}`;
    const pipelines = await Promise.all(
      ["compact", "finalize"].map((entryPoint) =>
        cache.prepare({
          label: `SCGI/route ${entryPoint}`,
          layout: { bindGroupLayouts: [{ entries }] },
          compute: { module: { code }, entryPoint },
        }),
      ),
    );
    const buffer = device.createBuffer({
      label: "SCGI/reusable routed rays",
      size: bytes,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
    });
    let indirect: GPUBuffer | undefined;
    let counters: GPUBuffer | undefined;
    try {
      indirect = device.createBuffer({
        label: "SCGI/routed dispatch",
        size: 32,
        usage: GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST,
      });
      const routeCount = scene.arenas.reduce((count, arena) => count + arena.routes.length, 0);
      if (diagnostics) {
        counters = device.createBuffer({
          label: "SCGI/last batch route counters",
          size: routeCount * 32,
          usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
        });
      }
      const groups = new Map<ScgiQueryArenaRoute, GPUBindGroup>();
      for (const arena of scene.arenas) {
        for (const route of arena.routes) {
          groups.set(
            route,
            device.createBindGroup({
              layout,
              entries: [batch, route.tlas, rayWork.buffer, buffer].map((resource, binding) => ({
                binding,
                resource: { buffer: resource },
              })),
            }),
          );
        }
      }
      return new ScgiQueryRouteWork(
        buffer,
        indirect,
        counters,
        pipelines[0]!,
        pipelines[1]!,
        groups,
        rayWork,
      );
    } catch (error) {
      buffer.destroy();
      indirect?.destroy();
      counters?.destroy();
      throw error;
    }
  }

  encode(command: ShadeGPUCommandContext, route: ScgiQueryArenaRoute): void {
    command.clearBuffer(this.buffer, 0, 32);
    const group = this.groups.get(route);
    if (group === undefined) {
      throw new Error("Query route is outside its admitted scene");
    }
    for (const pipeline of [this.pipeline, this.finalize]) {
      const pass = command.beginComputePass({ label: pipeline.label });
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, group);
      if (pipeline === this.pipeline) {
        pass.dispatchWorkgroupsIndirect(this.rayWork.indirect, 32);
      } else {
        pass.dispatchWorkgroups(1);
      }
      pass.end();
    }
    command.copyBufferToBuffer(this.buffer, 0, this.indirect, 0, 32);
  }

  capture(command: ShadeGPUCommandContext, route: ScgiQueryArenaRoute): void {
    if (this.counters === undefined) {
      return;
    }
    let index = 0;
    for (const key of this.groups.keys()) {
      if (key === route) {
        command.copyBufferToBuffer(this.buffer, 0, this.counters, index * 32, 32);
        return;
      }
      index++;
    }
    throw new Error("Query route has no counter slot");
  }

  destroy(): void {
    this.buffer.destroy();
    this.indirect.destroy();
    this.counters?.destroy();
  }
}
