import type { FrameGraph } from "../../framegraph/FrameGraph.js";
import type { ResourceId } from "../../framegraph/ResourceHandle.js";
import type { ShadeGPUCommandContext } from "../../framegraph/ShadeGPUCommandContext.js";
import { SurfaceFrameResources, type SurfaceResourceBinding } from "./SurfaceFrameResources.js";
// A single exact comparison replaces per-sample whole-table hashing. Oversized
// tables disable texture reuse by advancing the epoch every frame, never aliasing.
const WGSL = `
@group(0) @binding(0) var<storage,read> current:array<u32>;
@group(0) @binding(1) var<storage,read_write> state:array<u32>;
@compute @workgroup_size(1) fn update(){
 let count=arrayLength(&current); var changed=state[0]==0u || state[1]!=count;
 if count>arrayLength(&state)-2u { state[0]=select(state[0]+1u,0xffffffffu,state[0]>=0xfffffffeu);state[1]=count;return; }
 for(var i=0u;i<count;i++){changed=changed || state[2u+i]!=current[i];state[2u+i]=current[i];}
 if changed{state[0]=select(state[0]+1u,0xffffffffu,state[0]>=0xfffffffeu);}state[1]=count;
}`;
export class SurfaceDependencyEpochPass {
    private readonly pipeline: GPUComputePipeline;
    constructor(private readonly device: GPUDevice, private readonly scratch: SurfaceFrameResources) {
        this.pipeline = device.createComputePipeline({ label: "Surface/residency epoch", layout: "auto", compute: { module: device.createShaderModule({ code: WGSL }), entryPoint: "update" } });
    }
    addToGraph(graph: FrameGraph, current: ResourceId, bind: SurfaceResourceBinding): ResourceId {
        let state = this.scratch.importBuffer(graph, bind, "Surface/residency epoch", (65536 + 2) * 4, GPUBufferUsage.STORAGE);
        const node = graph.add("Surface/residency epoch", {}, (_data, resources, context) => {
            const cmd = context.encoder as ShadeGPUCommandContext;
            const group = this.device.createBindGroup({ layout: this.pipeline.getBindGroupLayout(0), entries: [
                    { binding: 0, resource: { buffer: resources.get(current) as GPUBuffer } }, { binding: 1, resource: { buffer: resources.get(state) as GPUBuffer } }
                ] });
            const pass = cmd.beginComputePass({ label: "Surface/residency epoch" });
            pass.setPipeline(this.pipeline);
            pass.setBindGroup(0, group);
            pass.dispatchWorkgroups(1);
            pass.end();
        });
        node.read(current);
        node.read(state);
        state = node.write(state);
        return state;
    }
}
