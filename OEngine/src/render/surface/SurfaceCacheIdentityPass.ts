import type { FrameGraph } from "../../framegraph/FrameGraph.js";
import type { ResourceId } from "../../framegraph/ResourceHandle.js";
import type { ShadeGPUCommandContext } from "../../framegraph/ShadeGPUCommandContext.js";
import { GPU_INSTANCE_RECORD_WGSL } from "../../gpu/GpuInstanceAbi.js";
import { GPU_FRAME_INSTANCE_WGSL } from "../../gpu/GpuFrameInstanceAbi.js";
import { GPU_MESHLET_RASTER_WORK_WGSL } from "../../gpu/GpuMeshletRasterWorkAbi.js";
import { GPU_VISIBILITY_KEY_WGSL } from "../../gpu/GpuVisibilityKeyAbi.js";
import { SURFACE_WORK_INDIRECT_OFFSET } from "../../gpu/GpuSurfaceWorkAbi.js";
import { PACKED_CAMERA_TYPE } from "../../shaders/packed_camera.js";
import { SurfaceFrameResources, type SurfaceResourceBinding } from "./SurfaceFrameResources.js";
/** Exact producer-input witness. No geometry decoding, texture sampling or hashes.
 * Each covered representative owns one pixel cell, so publication has no collisions.
 * Equal view + instance/product generations + primitive implies identical geometry
 * and UV/filtered footprint inputs. Dependency-specific field versions are separate. */
const WGSL = `${GPU_INSTANCE_RECORD_WGSL}\n${GPU_FRAME_INSTANCE_WGSL}\n${GPU_MESHLET_RASTER_WORK_WGSL}\n${GPU_VISIBILITY_KEY_WGSL}
struct Settings { sample_offset:u32, view:u32, scene:u32, capacity:u32 }
@group(0) @binding(0) var<uniform> settings:Settings;
@group(0) @binding(1) var<storage,read_write> work:array<u32>;
@group(0) @binding(2) var<storage,read> counts:array<u32>;
@group(0) @binding(3) var<storage,read> meshlets:OEngineMeshletWorkQueueRead;
@group(0) @binding(4) var<storage,read> instances:array<OEngineFrameInstanceRecord>;
@group(0) @binding(5) var<storage,read_write> keys:array<u32>;
@group(0) @binding(6) var<storage,read> view_epoch:array<u32>;
@compute @workgroup_size(64)
fn identity(@builtin(global_invocation_id) id:vec3u) {
  let record=id.x; if record>=counts[0] || record>=settings.capacity { return; }
  let sample=settings.sample_offset+record*8u;
  let pixel=work[sample]; let key=oengine_visibility_key_resolve(work[sample+1u],meshlets.header.generation,meshlets.header.written_count);
  work[sample+6u]=pixel;
  if key.valid==0u { work[sample+7u]=0u; return; }
  let item=meshlets.elements[key.meshlet_work_slot]; let instance=instances[item.instance_slot].source;
  let witness=array<u32,12>(view_epoch[0],settings.scene,item.geometry_slot,item.meshlet_slot,item.instance_slot,
    key.local_primitive,oengine_instance_geometry_generation(instance),instance.dynamic_revision,
    item.packed_profile_lod,oengine_instance_product_table_slot(instance),instance.instance_set_generation,instance.flags);
  let base=pixel*13u; var same=keys[base+12u]!=0u && keys[base+12u]!=0xffffffffu && view_epoch[0]!=0xffffffffu;
  for(var i=0u;i<12u;i++){same=same && keys[base+i]==witness[i];}
  if !same {
    for(var i=0u;i<12u;i++){keys[base+i]=witness[i];}
    keys[base+12u]=select(keys[base+12u]+1u,0xffffffffu,keys[base+12u]>=0xfffffffeu);
  }
  // Bit 2 carries the exact geometry hit to the sole GeometryRecord producer.
  work[sample+7u]=select(1u,5u,same);
}
`;
export class SurfaceCacheIdentityPass {
    private readonly pipeline: GPUComputePipeline;
    private readonly layout: GPUBindGroupLayout;
    private readonly settings: GPUBuffer;
    private readonly viewPipeline: GPUComputePipeline;
    constructor(private readonly device: GPUDevice, private readonly scratch: SurfaceFrameResources) {
        this.settings = device.createBuffer({ label: "Surface input witness settings", size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
        this.layout = device.createBindGroupLayout({ entries: [{ binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
                ...[1, 2, 3, 4, 5, 6].map(binding => ({ binding, visibility: GPUShaderStage.COMPUTE, buffer: { type: ([1, 5].includes(binding) ? "storage" : "read-only-storage") as GPUBufferBindingType } }))] });
        this.pipeline = device.createComputePipeline({ label: "Surface/input witness", layout: device.createPipelineLayout({ bindGroupLayouts: [this.layout] }),
            compute: { module: device.createShaderModule({ code: WGSL }), entryPoint: "identity" } });
        this.viewPipeline = device.createComputePipeline({ label: "Surface/exact view epoch", layout: "auto", compute: { entryPoint: "update", module: device.createShaderModule({ code: `
      struct CameraWords{words:array<vec4u,${PACKED_CAMERA_TYPE.size / 16}>}
      @group(0) @binding(0) var<uniform> camera:CameraWords;
      @group(0) @binding(1) var<storage,read_write> snapshot:array<u32>;
      @compute @workgroup_size(1) fn update(){var changed=snapshot[0]==0u;
        for(var i=0u;i<${PACKED_CAMERA_TYPE.size / 4}u;i++){let word=camera.words[i/4u][i%4u];changed=changed || snapshot[i+1u]!=word;snapshot[i+1u]=word;}
        if changed{snapshot[0]=select(snapshot[0]+1u,0xffffffffu,snapshot[0]>=0xfffffffeu);}
      }` }) } });
    }
    addToGraph(graph: FrameGraph, input: {
        camera: ResourceId;
        work: ResourceId;
        counts: ResourceId;
        meshlets: ResourceId;
        instances: ResourceId;
        sampleOffset: number;
        capacity: number;
        pixelCount: number;
        view: Readonly<{
            value: number;
        }>;
        scene: Readonly<{
            value: number;
        }>;
        bind: SurfaceResourceBinding;
    }): {
        keys: ResourceId;
        work: ResourceId;
    } {
        let keys = this.scratch.importBuffer(graph, input.bind, "Surface/exact input witness", input.pixelCount * 52, GPUBufferUsage.STORAGE);
        let viewEpoch = this.scratch.importBuffer(graph, input.bind, "Surface/exact view epoch", PACKED_CAMERA_TYPE.size + 4, GPUBufferUsage.STORAGE);
        const viewNode = graph.add("Surface/exact view epoch", {}, (_data, resources, context) => {
            const cmd = context.encoder as ShadeGPUCommandContext;
            const bind = this.device.createBindGroup({ layout: this.viewPipeline.getBindGroupLayout(0), entries: [
                    { binding: 0, resource: { buffer: resources.get(input.camera) as GPUBuffer } }, { binding: 1, resource: { buffer: resources.get(viewEpoch) as GPUBuffer } }
                ] });
            const pass = cmd.beginComputePass({ label: "Surface/view epoch" });
            pass.setPipeline(this.viewPipeline);
            pass.setBindGroup(0, bind);
            pass.dispatchWorkgroups(1);
            pass.end();
        });
        viewNode.read(input.camera);
        viewNode.read(viewEpoch);
        viewEpoch = viewNode.write(viewEpoch);
        let indirect!: ResourceId;
        const node = graph.add("Surface/exact input witness", input, (data, resources, context) => {
            const cmd = context.encoder as ShadeGPUCommandContext;
            cmd.writeBuffer(this.settings, 0, new Uint32Array([data.sampleOffset / 4, data.view.value, data.scene.value, data.capacity]).buffer, 0, 16);
            cmd.gpu_encoder.copyBufferToBuffer(resources.get(data.counts) as GPUBuffer, SURFACE_WORK_INDIRECT_OFFSET, resources.get(indirect) as GPUBuffer, 0, 16);
            const ids = [data.work, data.counts, data.meshlets, data.instances, keys, viewEpoch];
            const group = this.device.createBindGroup({ layout: this.layout, entries: [{ binding: 0, resource: { buffer: this.settings } },
                    ...ids.map((id, index) => ({ binding: index + 1, resource: { buffer: resources.get(id) as GPUBuffer } }))] });
            const pass = cmd.beginComputePass({ label: "Surface/input witness" });
            pass.setPipeline(this.pipeline);
            pass.setBindGroup(0, group);
            pass.dispatchWorkgroupsIndirect(resources.get(indirect) as GPUBuffer, 0);
            pass.end();
        });
        for (const id of [input.work, input.counts, input.meshlets, input.instances, keys, viewEpoch])
            node.read(id);
        keys = node.write(keys);
        const work = node.write(input.work);
        indirect = node.create("Surface/witness indirect", { kind: "transient_buffer", size: 16, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.INDIRECT });
        return { keys, work };
    }
    destroy(): void { this.settings.destroy(); }
}
