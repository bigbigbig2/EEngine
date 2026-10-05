import type { FrameGraph } from "../../framegraph/FrameGraph.js";
import type { ResourceId } from "../../framegraph/ResourceHandle.js";
import type { ShadeGPUCommandContext } from "../../framegraph/ShadeGPUCommandContext.js";
import { surfaceCellWorkspaceWgsl } from "../../gpu/GpuSurfaceCellPlanAbi.js";
import { surfaceDemandArenaWgsl } from "../../gpu/GpuSurfaceDemandAbi.js";
import { SURFACE_GEOMETRY_RECORD_BYTES, SURFACE_GEOMETRY_RECORD_WGSL } from "../../gpu/GpuSurfaceGeometryRecordAbi.js";
import { PACKED_CAMERA_TYPE } from "../../shaders/packed_camera.js";
import { WINNER_INTERPOLATION_WGSL } from "../../shaders/winner_interpolation.js";
import { SURFACE_CELL_GEOMETRY_WGSL, surfaceCellGeometryArenaWgsl } from "../../gpu/GpuSurfaceCellGeometryAbi.js";
import { SurfaceFrameResources, type SurfaceResourceBinding } from "./SurfaceFrameResources.js";
import { SurfaceCellGeometrySetup, type SurfaceCellGeometrySetupInput, type SurfaceCellGeometrySetupProducts } from "./SurfaceCellGeometrySetup.js";
import type { SurfaceDemandProducts } from "./SurfaceDemandPass.js";
import { SURFACE_CELL_ADDRESS_WORDS } from "../../gpu/GpuSurfaceReferenceAbi.js";
export function surfaceGeometryRecordWgsl(targets: number, programs: number, referenceCapacity = targets): string {
    return /* wgsl */ `
${surfaceCellWorkspaceWgsl(targets / 64)}
${surfaceDemandArenaWgsl(targets, programs)}
${SURFACE_GEOMETRY_RECORD_WGSL}
${PACKED_CAMERA_TYPE.wgsl_declaration}
${WINNER_INTERPOLATION_WGSL}
${SURFACE_CELL_GEOMETRY_WGSL}
${surfaceCellGeometryArenaWgsl(referenceCapacity,false)}
@group(0) @binding(0) var<storage, read_write> workspace: SurfaceCellWorkspace;
@group(0) @binding(1) var<storage, read_write> demand: SurfaceDemandArena;
@group(0) @binding(2) var<uniform> camera: CommandEncoder;
@group(0) @binding(3) var<storage, read_write> records: array<u32>;
@group(0) @binding(4) var<storage, read> geometry_arena: CellGeometryArenaRead;
@group(0) @binding(5) var<uniform> viewport: vec4u;
fn geometry_attribute(setup:CellGeometrySetup,attribute_index:u32,weights:vec3f)->vec4f {
  return setup.corners[attribute_index]*weights.x+setup.corners[attribute_index+6u]*weights.y+setup.corners[attribute_index+12u]*weights.z;
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
  let at = leaf * ${SURFACE_CELL_ADDRESS_WORDS}u;
  let setup=geometry_arena.setups[workspace.facts[leaf].y];
  let pixel=workspace.addresses[at+13u];
  let interpolation=winner_interpolate(setup.coefficients,vec2f(f32(pixel%viewport.x),f32(pixel/viewport.x))+vec2f(0.5),vec2f(viewport.xy));
  let mask = atomicLoad(&demand.geometry_masks[leaf]);
  var record: SurfaceGeometryRecord;
  var physical_mask=0u;
  for(var kind=1u;kind<=14u;kind++) {
    if (mask&(1u<<kind))!=0u { physical_mask|=1u<<SURFACE_GEOMETRY_PHYSICAL[kind-1u]; }
  }
  let cold_words=countOneBits(physical_mask)*12u;
  let cold=${targets*32}u+atomicAdd(&demand.control[46u],cold_words);
  record.cold=vec4u(cold,physical_mask,mask,0u);
  let geometric = geometry_normal(setup.world_plane.xyz, vec3f(0.0,0.0,1.0));
  record.geometric = vec4f(geometric, 1.0);
  record.identity = vec4u(workspace.addresses[at+13u], workspace.addresses[at+4u], workspace.facts[leaf].z, workspace.addresses[at+17u]);
  for (var point = 0u; point < 3u; point++) {
    if point != 0u && physical_mask == 0u { continue; }
    var weights=interpolation.weights;
    if point==1u { weights+=interpolation.dx; }
    if point==2u { weights+=interpolation.dy; }
    let position = geometry_attribute(setup,5u,weights);
    let raw_normal = geometry_attribute(setup,0u,weights);
    let raw_tangent = geometry_attribute(setup,1u,weights);
    var normal = geometry_normal(raw_normal.xyz, geometric);
    var tangent = geometry_normal(raw_tangent.xyz-normal*dot(normal,raw_tangent.xyz),
      geometry_normal(cross(select(vec3f(0.0,0.0,1.0),vec3f(0.0,1.0,0.0),abs(normal.z)>0.99),normal),vec3f(1.0,0.0,0.0)));
    var facing_normal=raw_normal.xyz;
    if dot(facing_normal,facing_normal)<=1e-20 { facing_normal=setup.world_plane.xyz; }
    if (setup.source_address.w&16u)!=0u && dot(facing_normal,camera.transform[3u].xyz-position.xyz)<0.0 {
      normal=-normal;tangent=-tangent;
    }
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
          let attribute_value=geometry_attribute(setup,select(2u,4u,kind==3u),weights);
          value=vec4f(select(attribute_value.xy,attribute_value.zw,kind==2u),0.0,0.0);
        }
        case 4u: { value=geometry_attribute(setup,3u,weights); }
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
        setup: SurfaceCellGeometrySetupProducts;
        width: number;
        height: number;
    }): {
        records: ResourceId;
    } {
        const { targets, programs } = input.demand.layout;
        const key = `${targets}:${programs}:${input.setup.referenceCapacity}`;
        let pipeline = this.pipelines.get(key);
        if (pipeline === undefined) {
            pipeline = this.device.createComputePipeline({
                label: "Surface/unique GeometryRecord", layout: "auto",
                compute: { module: this.device.createShaderModule({ code: surfaceGeometryRecordWgsl(targets, programs,input.setup.referenceCapacity) }), entryPoint: "produce_geometry" }
            });
            this.pipelines.set(key, pipeline);
        }
        let records = this.scratch.importBuffer(graph, input.bind, "Surface/unique GeometryRecord", targets * SURFACE_GEOMETRY_RECORD_BYTES, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC);
        const node = graph.add("Surface/unique GeometryRecord", { records, demand: input.demand }, (data, resources, context) => {
            const command = context.encoder as ShadeGPUCommandContext;
            const viewport=command.allocateTransientBuffer(GPUBufferUsage.UNIFORM,16);
            command.writeBuffer(viewport,0,new Uint32Array([input.width,input.height,0,0]).buffer,0,16);
            const group = this.device.createBindGroup({ layout: pipeline!.getBindGroupLayout(0), entries: [
                    { binding: 0, resource: { buffer: resources.get(data.demand.workspace) as GPUBuffer } },
                    { binding: 1, resource: { buffer: resources.get(data.demand.arena) as GPUBuffer } },
                    { binding: 2, resource: { buffer: resources.get(input.camera) as GPUBuffer } },
                    { binding: 3, resource: { buffer: resources.get(data.records) as GPUBuffer } },
                    { binding: 4, resource: { buffer: resources.get(input.setup.arena) as GPUBuffer } },
                    { binding: 5, resource: { buffer: viewport } }
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
        node.read(input.setup.arena);
        records = node.write(records);
        return { records };
    }
    destroy(): void { this.setup.destroy(); this.pipelines.clear(); }
}
