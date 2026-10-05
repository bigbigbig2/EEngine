import type { FrameGraph } from "../../framegraph/FrameGraph.js";
import type { ResourceId } from "../../framegraph/ResourceHandle.js";
import type { ShadeGPUCommandContext } from "../../framegraph/ShadeGPUCommandContext.js";
import {
  LIGHT_DATABASE_READ_WGSL,
  DIRECTIONAL_LIGHT_DESCRIPTOR,
  POINT_LIGHT_DESCRIPTOR,
  SPOT_LIGHT_DESCRIPTOR,
} from "../../gpu/LightDatabase.js";
import type { SurfaceFrameResources } from "./SurfaceFrameResources.js";

/** One current-provider numeric proof, before material publication and lookup.
 * This changes no visible/work count and requires no CPU readback or submit.
 * All active light records and all actual solar LUT texels are included. */
export const SURFACE_RADIOMETRY_WGSL = /* wgsl */ `
${LIGHT_DATABASE_READ_WGSL}
fn saturate(value: f32) -> f32 { return clamp(value, 0.0, 1.0); }
struct RadiometrySettings { output: u32, solar: u32, reserved: vec2u, }
struct RadiometryClusters {
  attempted: u32, written: u32, capacity: u32, overflow: u32,
  active_written: u32, reserved0: u32, reserved1: u32, reserved2: u32, data: array<u32>,
}
@group(0) @binding(0) var<uniform> settings: RadiometrySettings;
@group(0) @binding(1) var<storage, read> lights: array<u32>;
@group(0) @binding(2) var<storage, read> clusters: RadiometryClusters;
@group(0) @binding(3) var<uniform> solar: array<vec4f, 3>;
@group(0) @binding(4) var solar_transmittance: texture_2d<f32>;
@group(0) @binding(5) var<storage, read_write> metadata: array<u32>;
var<workgroup> numeric_safe: array<u32, 64>;
fn radiometry_bounded(value: vec3f, bound: f32) -> bool {
  return all(value == value) && all(abs(value) <= vec3f(bound));
}
@compute @workgroup_size(64)
fn prove_radiometry(@builtin(local_invocation_index) lane: u32) {
  var valid = true;
  let directional = directional_lights_iteration_mask(&lights);
  if lane < 32u && (directional & (1u << lane)) != 0u {
    let light = ${DIRECTIONAL_LIGHT_DESCRIPTOR.marshalling_method_read}(&lights, lane);
    valid = radiometry_bounded(light.color, 1e8) && radiometry_bounded(light.direction, 1e6);
  }
  valid = valid && clusters.active_written <= arrayLength(&clusters.data);
  for (var i = lane; i < min(clusters.active_written, arrayLength(&clusters.data)); i += 64u) {
    let tuple = clusters.data[i];
    let index = tuple & 0x00ffffffu;
    if (tuple >> 24u) == 0u {
      let light = ${POINT_LIGHT_DESCRIPTOR.marshalling_method_read}(&lights, index);
      valid = valid && radiometry_bounded(light.color, 1e8) &&
        radiometry_bounded(vec3f(light.radius, light.distance, 0.0), 1e12);
    } else if (tuple >> 24u) == 1u {
      let light = ${SPOT_LIGHT_DESCRIPTOR.marshalling_method_read}(&lights, index);
      valid = valid && radiometry_bounded(light.color, 1e8) &&
        radiometry_bounded(vec3f(light.radius, light.distance, 0.0), 1e12) &&
        radiometry_bounded(light.direction, 1e6) && light.coneCos < light.penumbraCos &&
        abs(light.coneCos) <= 1.0 && abs(light.penumbraCos) <= 1.0;
    } else { valid = false; }
  }
  if settings.solar != 0u {
    valid = valid && radiometry_bounded(solar[0].xyz, 1e6) &&
      radiometry_bounded(solar[1].xyz, 1e8);
    let size = textureDimensions(solar_transmittance);
    for (var i = lane; i < size.x * size.y; i += 64u) {
      let value = textureLoad(solar_transmittance, vec2i(vec2u(i % size.x, i / size.x)), 0).xyz;
      valid = valid && radiometry_bounded(value, 1e4);
    }
  }
  numeric_safe[lane] = u32(valid);
  workgroupBarrier();
  for (var stride = 32u; stride != 0u; stride /= 2u) {
    if lane < stride { numeric_safe[lane] &= numeric_safe[lane + stride]; }
    workgroupBarrier();
  }
  if lane == 0u {
    metadata[settings.output] = numeric_safe[0];
    for (var channel = 0u; channel < 3u; channel++) {
      metadata[settings.output + 1u + channel] = bitcast<u32>(solar[0][channel]);
    }
  }
}
`;

export class SurfaceRadiometryPass {
  private readonly pipeline: GPUComputePipeline;
  private readonly disabledSun: GPUBuffer;
  private readonly disabledTransmittance: GPUTexture;
  private readonly disabledTransmittanceView: GPUTextureView;
  private readonly settings: GPUBuffer;

  constructor(
    private readonly device: GPUDevice,
    private readonly scratch: SurfaceFrameResources,
  ) {
    this.settings = device.createBuffer({
      label: "Surface/radiometry settings",
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.pipeline = device.createComputePipeline({
      label: "Surface/current radiometry envelope",
      layout: "auto",
      compute: {
        module: device.createShaderModule({ code: SURFACE_RADIOMETRY_WGSL }),
        entryPoint: "prove_radiometry",
      },
    });
    this.disabledSun = device.createBuffer({ size: 48, usage: GPUBufferUsage.UNIFORM });
    this.disabledTransmittance = device.createTexture({
      size: [1, 1],
      format: "rgba8unorm",
      usage: GPUTextureUsage.TEXTURE_BINDING,
    });
    this.disabledTransmittanceView = this.disabledTransmittance.createView();
  }

  addToGraph(
    graph: FrameGraph,
    input: {
      readonly metadata: ResourceId;
      readonly offset: number;
      readonly lightRecords: ResourceId;
      readonly clusters: ResourceId;
      readonly sun: ResourceId | null;
      readonly transmittance: ResourceId | null;
    },
  ): ResourceId {
    if (input.sun !== null && input.transmittance === null) {
      throw new Error("Surface radiometry requires the actual solar transmittance publication");
    }
    const sun =
      input.sun ??
      graph.import_resource("Surface/radiometry disabled solar", { kind: "imported" }, this.disabledSun);
    const transmittance =
      input.transmittance ??
      graph.import_resource(
        "Surface/radiometry disabled transmission",
        { kind: "imported" },
        this.disabledTransmittanceView,
      );
    const node = graph.add("Surface/current radiometry envelope", input, (_data, resources, context) => {
      const command = context.encoder as ShadeGPUCommandContext;
      const settings = this.settings;
      command.writeBuffer(
        settings,
        0,
        new Uint32Array([input.offset, input.sun === null ? 0 : 1, 0, 0]).buffer,
        0,
        16,
      );
      const group = this.scratch.obtainBindGroup(this.pipeline, 0, [
        { binding: 0, resource: { buffer: settings } },
        { binding: 1, resource: { buffer: resources.get(input.lightRecords) as GPUBuffer } },
        { binding: 2, resource: { buffer: resources.get(input.clusters) as GPUBuffer } },
        { binding: 3, resource: { buffer: resources.get(sun) as GPUBuffer } },
        { binding: 4, resource: this.scratch.resolveTextureView(resources.get(transmittance)) },
        { binding: 5, resource: { buffer: resources.get(input.metadata) as GPUBuffer } },
      ]);
      const pass = command.beginComputePass({ label: "Surface/current radiometry envelope" });
      pass.setPipeline(this.pipeline);
      pass.setBindGroup(0, group);
      pass.dispatchWorkgroups(1);
      pass.end();
    });
    node.read(input.lightRecords);
    node.read(input.clusters);
    node.read(sun);
    node.read(transmittance);
    node.read(input.metadata);
    return node.write(input.metadata);
  }

  destroy(): void {
    this.settings.destroy();
    this.disabledSun.destroy();
    this.disabledTransmittance.destroy();
  }
}
