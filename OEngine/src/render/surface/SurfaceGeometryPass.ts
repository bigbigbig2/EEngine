import type { FrameGraph } from "../../framegraph/FrameGraph.js";
import type { ResourceId } from "../../framegraph/ResourceHandle.js";
import type { ShadeGPUCommandContext } from "../../framegraph/ShadeGPUCommandContext.js";
import { surfaceCellWorkspaceWgsl } from "../../gpu/GpuSurfaceCellPlanAbi.js";
import { surfaceDemandArenaWgsl } from "../../gpu/GpuSurfaceDemandAbi.js";
import { SURFACE_GEOMETRY_RECORD_BYTES, SURFACE_GEOMETRY_RECORD_WGSL } from "../../gpu/GpuSurfaceGeometryRecordAbi.js";
import { PACKED_CAMERA_TYPE } from "../../shaders/packed_camera.js";
import { SurfaceFrameResources, type SurfaceResourceBinding } from "./SurfaceFrameResources.js";
import { SurfaceCellGeometrySetup, type SurfaceCellGeometrySetupInput, type SurfaceCellGeometrySetupProducts } from "./SurfaceCellGeometrySetup.js";
import type { SurfaceDemandProducts } from "./SurfaceDemandPass.js";
export function surfaceGeometryRecordWgsl(targets: number, programs: number): string {
    return /* wgsl */ `
${surfaceCellWorkspaceWgsl(targets / 64)}
${surfaceDemandArenaWgsl(targets, programs)}
${SURFACE_GEOMETRY_RECORD_WGSL}
${PACKED_CAMERA_TYPE.wgsl_declaration}
@group(0) @binding(0) var<storage, read_write> workspace: SurfaceCellWorkspace;
@group(0) @binding(1) var<storage, read_write> demand: SurfaceDemandArena;
@group(0) @binding(2) var<uniform> camera: CommandEncoder;
@group(0) @binding(3) var<storage, read_write> records: array<u32>;
fn geometry_address(at: u32) -> vec4f {
  return bitcast<vec4f>(vec4u(workspace.addresses[at], workspace.addresses[at+1u], workspace.addresses[at+2u], workspace.addresses[at+3u]));
}
fn geometry_normal(value: vec3f, fallback: vec3f) -> vec3f {
  let length2 = dot(value, value);
  if length2 > 1e-20 && all(value == value) { return value * inverseSqrt(length2); }
  return fallback;
}
fn geometry_write4(at: u32, value: vec4f) {
  let words = bitcast<vec4u>(value);
  for (var channel=0u;channel<4u;channel++) { records[at+channel]=words[channel]; }
}
@compute @workgroup_size(64)
fn produce_geometry(@builtin(global_invocation_id) id: vec3u) {
  if id.x >= atomicLoad(&demand.control[0u]) { return; }
  let leaf = demand.geometry_queue[id.x];
  let at = leaf * 144u;
  let mask = atomicLoad(&demand.geometry_masks[leaf]);
  var record: SurfaceGeometryRecord;
  var physical_mask=0u;
  for(var kind=1u;kind<=14u;kind++) {
    if (mask&(1u<<kind))!=0u { physical_mask|=1u<<SURFACE_GEOMETRY_PHYSICAL[kind-1u]; }
  }
  let cold_words=countOneBits(physical_mask)*12u;
  let cold=${targets*32}u+atomicAdd(&demand.control[46u],cold_words);
  record.cold=vec4u(cold,physical_mask,mask,0u);
  let geometric = geometry_normal(geometry_address(at+132u).xyz, vec3f(0.0,0.0,1.0));
  record.geometric = vec4f(geometric, 1.0);
  record.identity = vec4u(workspace.addresses[at+13u], workspace.addresses[at+4u], workspace.facts[leaf].z, workspace.addresses[at+130u]);
  for (var point = 0u; point < 3u; point++) {
    let position = geometry_address(at+94u+point*4u);
    let raw_normal = geometry_address(at+106u+point*4u);
    let raw_tangent = geometry_address(at+118u+point*4u);
    var normal = geometry_normal(raw_normal.xyz, geometric);
    var tangent = geometry_normal(raw_tangent.xyz-normal*dot(normal,raw_tangent.xyz),
      geometry_normal(cross(select(vec3f(0.0,0.0,1.0),vec3f(0.0,1.0,0.0),abs(normal.z)>0.99),normal),vec3f(1.0,0.0,0.0)));
    if (workspace.addresses[at+131u] & (1u<<point)) != 0u { normal=-normal;tangent=-tangent; }
    let direction = geometry_normal(camera.transform[3u].xyz-position.xyz,normal);
    var written_mask=0u;
    for (var kind = 1u; kind <= 14u; kind++) {
      if (mask & (1u<<kind)) == 0u { continue; }
      let physical=SURFACE_GEOMETRY_PHYSICAL[kind-1u];
      if (written_mask&(1u<<physical))!=0u { continue; }
      written_mask|=1u<<physical;
      var value: vec4f;
      switch kind {
        case 1u, 2u, 3u: {
          let source = at+16u+(kind-1u)*6u;
          var uv = bitcast<vec2f>(vec2u(workspace.addresses[source],workspace.addresses[source+1u]));
          if point != 0u { uv += bitcast<vec2f>(vec2u(workspace.addresses[source+point*2u],workspace.addresses[source+point*2u+1u])); }
          value=vec4f(uv,0.0,0.0);
        }
        case 4u: { value=geometry_address(at+34u);if point!=0u { value+=geometry_address(at+34u+point*4u); } }
        case 5u, 11u: { value=vec4f(normal,raw_normal.w); }
        case 6u, 12u: { value=vec4f(tangent,raw_tangent.w); }
        case 7u, 10u: { value=position; }
        case 8u: { value=vec4f(direction,0.0); }
        case 9u: { value=vec4f(camera.transform[3u].xyz,1.0); }
        case 13u: { value=camera.view_matrix*vec4f(position.xyz,1.0); }
        case 14u: { value=vec4f((camera.view_matrix*vec4f(normal,0.0)).xyz,raw_normal.w); }
        default: {}
      }
      let rank=countOneBits(physical_mask&((1u<<physical)-1u));
      // Each alias writes the same physical value; a single invocation owns
      // this record and preserves independent requested semantic bits.
      geometry_write4(cold+rank*12u+point*4u,value);
    }
    if point==0u {
      record.position=position;
      record.normal=vec4f(normal,raw_normal.w);
      record.tangent=vec4f(tangent,raw_tangent.w);
      record.view=vec4f(direction,0.0);
      // z carries the exact union mask selected by Demand; w is reserved for
      // the cold/profile segment token. Consumers never reconstruct missing
      // attributes from source vertices.
      record.metrics=vec4f(-(camera.view_matrix*vec4f(position.xyz,1.0)).z,raw_tangent.w,bitcast<f32>(mask),0.0);
    }
  }
  let hot=leaf*32u;
  geometry_write4(hot,record.position);
  geometry_write4(hot+4u,record.normal);
  geometry_write4(hot+8u,record.tangent);
  geometry_write4(hot+12u,record.view);
  geometry_write4(hot+16u,record.geometric);
  for(var word=0u;word<4u;word++) { records[hot+20u+word]=record.identity[word];records[hot+28u+word]=record.cold[word]; }
  geometry_write4(hot+24u,record.metrics);
}
`;
}
/** Geometry owns both address setup and the sole miss value producer. */
export class SurfaceGeometryPass {
    private readonly setup: SurfaceCellGeometrySetup;
    private readonly pipelines = new Map<string, GPUComputePipeline>();
    constructor(private readonly device: GPUDevice, private readonly scratch: SurfaceFrameResources) {
        this.setup = new SurfaceCellGeometrySetup(device, scratch);
    }
    addCellSetupsToGraph(graph: FrameGraph, input: SurfaceCellGeometrySetupInput): SurfaceCellGeometrySetupProducts {
        return this.setup.addToGraph(graph, input);
    }
    addToGraph(graph: FrameGraph, input: {
        demand: SurfaceDemandProducts;
        camera: ResourceId;
        bind: SurfaceResourceBinding;
    }): {
        records: ResourceId;
    } {
        const { targets, programs } = input.demand.layout;
        const key = `${targets}:${programs}`;
        let pipeline = this.pipelines.get(key);
        if (pipeline === undefined) {
            pipeline = this.device.createComputePipeline({
                label: "Surface/unique GeometryRecord", layout: "auto",
                compute: { module: this.device.createShaderModule({ code: surfaceGeometryRecordWgsl(targets, programs) }), entryPoint: "produce_geometry" }
            });
            this.pipelines.set(key, pipeline);
        }
        let records = this.scratch.importBuffer(graph, input.bind, "Surface/unique GeometryRecord", targets * SURFACE_GEOMETRY_RECORD_BYTES, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC);
        const node = graph.add("Surface/unique GeometryRecord", { records, demand: input.demand }, (data, resources, context) => {
            const command = context.encoder as ShadeGPUCommandContext;
            const group = this.device.createBindGroup({ layout: pipeline!.getBindGroupLayout(0), entries: [
                    { binding: 0, resource: { buffer: resources.get(data.demand.workspace) as GPUBuffer } },
                    { binding: 1, resource: { buffer: resources.get(data.demand.arena) as GPUBuffer } },
                    { binding: 2, resource: { buffer: resources.get(input.camera) as GPUBuffer } },
                    { binding: 3, resource: { buffer: resources.get(data.records) as GPUBuffer } }
                ] });
            const pass = command.beginComputePass({ label: "Surface/unique GeometryRecord" });
            pass.setPipeline(pipeline!);
            pass.setBindGroup(0, group);
            pass.dispatchWorkgroupsIndirect(resources.get(data.demand.indirect) as GPUBuffer, 32);
            pass.end();
        });
        node.read(input.demand.workspace);
        node.read(input.demand.arena);
        node.read(input.demand.indirect);
        node.read(input.camera);
        records = node.write(records);
        return { records };
    }
    destroy(): void { this.setup.destroy(); this.pipelines.clear(); }
}
