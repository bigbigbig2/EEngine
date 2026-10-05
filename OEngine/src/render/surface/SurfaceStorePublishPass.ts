import type { FrameGraph } from "../../framegraph/FrameGraph.js";
import type { ResourceId } from "../../framegraph/ResourceHandle.js";
import type { ShadeGPUCommandContext } from "../../framegraph/ShadeGPUCommandContext.js";
import type { SurfaceDemandInput, SurfaceDemandProducts } from "./SurfaceDemandPass.js";
import { surfaceStorePublishWgsl } from "../../shaders/surface_store_publish.js";
import type { SurfaceFrameResources } from "./SurfaceFrameResources.js";
export class SurfaceStorePublishPass {
    private readonly pipelines = new Map<string, readonly GPUComputePipeline[]>();
    private readonly sun: GPUBuffer;
    private readonly shadow: GPUBuffer;
    constructor(private readonly device: GPUDevice, private readonly scratch: SurfaceFrameResources) {
        this.sun = device.createBuffer({ label: "Surface/publish disabled sun", size: 48, usage: GPUBufferUsage.UNIFORM });
        this.shadow = device.createBuffer({ label: "Surface/publish disabled shadow", size: 16, usage: GPUBufferUsage.STORAGE });
    }
    addToGraph(graph: FrameGraph, input: SurfaceDemandInput & {
        demand: SurfaceDemandProducts;
        values: ResourceId;
        signal: boolean;
        entries: number;
        enabled: boolean;
    }): SurfaceDemandProducts {
        const { targets, programs } = input.demand.layout;
        const key = `${targets}:${programs}:${input.signal}`;
        let pipelines = this.pipelines.get(key);
        if (pipelines === undefined) {
            const entries: GPUBindGroupLayoutEntry[] = [];
            for (let binding = 0; binding < 9; binding++) {
                entries.push({ binding, visibility: GPUShaderStage.COMPUTE, buffer: { type: binding === 0 || binding === 7 ? "uniform" :
                            [1, 4, 5].includes(binding) ? "storage" : "read-only-storage" } });
            }
            const layout = this.device.createPipelineLayout({ bindGroupLayouts: [this.device.createBindGroupLayout({ entries })] });
            const module = this.device.createShaderModule({ label: "Surface/narrow unique Store publish", code: surfaceStorePublishWgsl(targets, programs, input.signal) });
            pipelines = ["admit_surface_values", "commit_surface_values", "publish_surface_references"].map(entryPoint => this.device.createComputePipeline({ label: `Surface/${input.signal ? "signal" : "field"} ${entryPoint}`, layout, compute: { module, entryPoint } }));
            this.pipelines.set(key, pipelines);
        }
        const sun = input.sun ?? graph.import_resource("Surface/publish disabled sun", { kind: "imported" }, input.bind("surface-publish-sun", () => this.sun));
        const shadow = input.shadow ?? graph.import_resource("Surface/publish disabled shadow", { kind: "imported" }, input.bind("surface-publish-shadow", () => this.shadow));
        let settings = this.scratch.importBuffer(graph, input.bind, "Surface/Store admission settings", 64,
            GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
        const configure = graph.add("Surface/Store admission settings", {}, (_data, resources, context) => {
            const command = context.encoder as ShadeGPUCommandContext;
            const offsets = input.publication.surfaceMetadataOffsets;
            command.writeBuffer(resources.get(settings) as GPUBuffer, 0, new Uint32Array([
                offsets.fieldIdentities, offsets.constantFields, input.leaves, input.entries, input.epoch.value, input.viewRevision.value,
                input.revisions.environment, input.revisions.light, input.revisions.shadow, input.revisions.sun,
                input.shadow === null ? 0 : 1, input.sun === null ? 0 : 1, input.enabled ? 1 : 0, input.diagnostics ? 1 : 0, 0, 0
            ]).buffer, 0, 64);
        });
        settings = configure.write(settings);
        let workspace = input.demand.workspace, arena = input.demand.arena;
        let store = input.signal ? input.demand.signalStore : input.demand.fieldStore;
        let previous = configure;
        for (const [index, pipeline] of pipelines.entries()) {
            const node = graph.add(`Surface/${input.signal ? "signal" : "field"} Store ${index}`, { workspace, arena, store }, (data, resources, context) => {
                const group = this.scratch.obtainBindGroup(pipeline, 0, [
                    { binding: 0, resource: { buffer: resources.get(settings) as GPUBuffer } },
                    { binding: 1, resource: { buffer: resources.get(data.workspace) as GPUBuffer } },
                    { binding: 2, resource: { buffer: resources.get(input.metadata) as GPUBuffer } },
                    { binding: 3, resource: { buffer: resources.get(input.versions) as GPUBuffer } },
                    { binding: 4, resource: { buffer: resources.get(data.arena) as GPUBuffer } },
                    { binding: 5, resource: { buffer: resources.get(data.store) as GPUBuffer } },
                    { binding: 6, resource: { buffer: resources.get(input.values) as GPUBuffer } },
                    { binding: 7, resource: { buffer: resources.get(sun) as GPUBuffer } },
                    { binding: 8, resource: { buffer: resources.get(shadow) as GPUBuffer } }
                ]);
                const pass = (context.encoder as ShadeGPUCommandContext).beginComputePass({ label: `Surface/${input.signal ? "signal" : "field"} Store ${index}` });
                pass.setPipeline(pipeline); pass.setBindGroup(0, group);
                const word = index === 2 ? (input.signal ? 24 : 20) : (input.signal ? 16 : 12);
                pass.dispatchWorkgroupsIndirect(resources.get(input.demand.indirect) as GPUBuffer, word * 4); pass.end();
            });
            for (const resource of [workspace, arena, store, input.values, input.metadata, input.versions, sun, shadow, settings]) node.read(resource);
            if (index === 0) arena = node.write(arena);
            if (index !== 2) store = node.write(store);
            if (index === 2) workspace = node.write(workspace);
            node.dependsOn(previous); node.read(input.demand.indirect); previous = node;
        }
        return { ...input.demand, workspace, arena, ...(input.signal ? { signalStore: store } : { fieldStore: store }) };
    }
    destroy(): void { this.sun.destroy(); this.shadow.destroy(); this.pipelines.clear(); }
}
