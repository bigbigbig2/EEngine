import type { FrameGraph } from "../../framegraph/FrameGraph.js";
import type { ResourceId } from "../../framegraph/ResourceHandle.js";
import type { ShadeGPUCommandContext } from "../../framegraph/ShadeGPUCommandContext.js";
import { SurfaceFrameResources } from "./SurfaceFrameResources.js";
import { surfaceLightingWgsl, type SurfaceLightingInput } from "./SurfaceLightingWorkPass.js";
import type { SurfaceDemandProducts } from "./SurfaceDemandPass.js";
import { resolveTextureView } from "../RenderTargetViews.js";
export class SurfaceLightingPass {
    private readonly pipelines = new Map<string, GPUComputePipeline>();
    private readonly layouts: readonly GPUBindGroupLayout[];
    private readonly parameters: GPUBuffer;
    private readonly pages: GPUBuffer;
    private readonly depth: GPUTexture;
    private readonly transmittance: GPUTexture;
    private readonly sampler: GPUSampler;
    constructor(private readonly device: GPUDevice, private readonly scratch: SurfaceFrameResources) {
        const visibility = GPUShaderStage.COMPUTE;
        const buffer = (binding: number, type: GPUBufferBindingType): GPUBindGroupLayoutEntry => ({ binding, visibility, buffer: { type } });
        const texture = (binding: number, sampleType: GPUTextureSampleType = "float"): GPUBindGroupLayoutEntry => ({ binding, visibility, texture: { sampleType } });
        this.layouts = [
            device.createBindGroupLayout({ entries: [buffer(0, "uniform"), buffer(1, "read-only-storage"), buffer(2, "read-only-storage"),
                    buffer(3, "read-only-storage"), buffer(4, "storage"), buffer(5, "storage"), buffer(6, "read-only-storage"), buffer(7, "storage"),
                    texture(13), texture(14), texture(15), buffer(16, "uniform"), texture(17), { binding: 18, visibility, sampler: { type: "filtering" } }] }),
            device.createBindGroupLayout({ entries: [buffer(0, "read-only-storage"), buffer(2, "uniform"), buffer(3, "read-only-storage"), buffer(4, "read-only-storage"), buffer(7, "read-only-storage")] }),
            device.createBindGroupLayout({ entries: [buffer(0, "uniform"), buffer(1, "uniform")] }),
            device.createBindGroupLayout({ entries: [buffer(0, "uniform"), buffer(1, "read-only-storage"), texture(2, "depth")] })
        ];
        this.parameters = device.createBuffer({ label: "Surface/disabled lighting parameters", size: 256, usage: GPUBufferUsage.UNIFORM });
        this.pages = device.createBuffer({ label: "Surface/disabled shadow pages", size: 32, usage: GPUBufferUsage.STORAGE });
        this.depth = device.createTexture({ label: "Surface/disabled shadow atlas", size: [1, 1], format: "depth32float", usage: GPUTextureUsage.TEXTURE_BINDING });
        this.transmittance = device.createTexture({ label: "Surface/disabled solar transport", size: [1, 1], format: "rgba16float", usage: GPUTextureUsage.TEXTURE_BINDING });
        this.sampler = device.createSampler({ minFilter: "linear", magFilter: "linear" });
    }
    addToGraph(graph: FrameGraph, input: SurfaceLightingInput): {
        values: ResourceId;
        demand: SurfaceDemandProducts;
    } {
        const { targets, programs, signalCapacity } = input.demand.layout;
        const key = `${targets}:${programs}`;
        let pipeline = this.pipelines.get(key);
        if (pipeline === undefined) {
            pipeline = this.device.createComputePipeline({ label: "Surface/unique dirty Lighting", layout: this.device.createPipelineLayout({ bindGroupLayouts: this.layouts }),
                compute: { module: this.device.createShaderModule({ code: surfaceLightingWgsl(targets, programs) }), entryPoint: "build" } });
            this.pipelines.set(key, pipeline);
        }
        const imported = <T extends object>(name: string, resolve: () => T): ResourceId => graph.import_resource(name, { kind: "imported" }, input.resourceBinding(name, resolve));
        const parameters = imported("surface-lighting-disabled-parameters", () => this.parameters);
        const pages = imported("surface-lighting-disabled-pages", () => this.pages);
        const depth = imported("surface-lighting-disabled-depth", () => this.depth.createView());
        const transport = imported("surface-lighting-disabled-transport", () => this.transmittance.createView());
        let values = this.scratch.importBuffer(graph, input.resourceBinding, "Surface/unique signal values", signalCapacity * 16, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC);
        const node = graph.add("Surface/unique dirty Lighting", { input, values }, (data, resources, context) => {
            const command = context.encoder as ShadeGPUCommandContext;
            const settings = command.allocateTransientBuffer(GPUBufferUsage.UNIFORM, 32);
            const view = command.allocateTransientBuffer(GPUBufferUsage.UNIFORM, 16);
            command.writeBuffer(settings, 0, new Uint32Array([input.width, input.height, input.constantFieldsOffset, input.shadow === null ? 0 : 1,
                input.physicalSun === null ? 0 : 1, input.diagnosticsEnabled ? 1 : 0, 0, 0]).buffer, 0, 32);
            command.writeBuffer(view, 0, new Uint32Array([input.width, input.height, input.frame, 0]).buffer, 0, 16);
            const b = (binding: number, id: ResourceId): GPUBindGroupEntry => ({ binding, resource: { buffer: resources.get(id) as GPUBuffer } });
            const t = (binding: number, id: ResourceId): GPUBindGroupEntry => ({ binding, resource: resolveTextureView(resources.get(id)) });
            const groups = [
                this.device.createBindGroup({ layout: this.layouts[0]!, entries: [{ binding: 0, resource: { buffer: settings } }, b(1, input.geometry), b(2, input.fields), b(3, input.demand.fieldStore),
                        b(4, input.demand.arena), b(5, input.demand.workspace), b(6, input.appearanceMetadata), b(7, data.values), t(13, input.environment.diffuse), t(14, input.environment.specular), t(15, input.environment.dfg),
                        b(16, input.physicalSun?.parameters ?? parameters), t(17, input.physicalSun?.transmittance ?? transport), { binding: 18, resource: this.sampler }] }),
                this.device.createBindGroup({ layout: this.layouts[1]!, entries: [b(0, input.lightRecords), b(2, input.clusters.parameters), b(3, input.clusters.lookup), b(4, input.clusters.data), b(7, input.clusters.activeLightList)] }),
                this.device.createBindGroup({ layout: this.layouts[2]!, entries: [{ binding: 0, resource: { buffer: view } }, b(1, input.camera)] }),
                this.device.createBindGroup({ layout: this.layouts[3]!, entries: [b(0, input.shadow?.lightProjection ?? parameters), b(1, input.shadow?.virtualPageTable ?? pages), t(2, input.shadow?.physicalAtlasDepth ?? depth)] })
            ];
            const pass = command.beginComputePass({ label: "Surface/unique dirty Lighting" });
            pass.setPipeline(pipeline!);
            groups.forEach((group, index) => pass.setBindGroup(index, group));
            pass.dispatchWorkgroupsIndirect(resources.get(input.demand.indirect) as GPUBuffer, 128);
            pass.end();
        });
        const reads = [input.geometry, input.fields, input.demand.fieldStore, input.demand.arena, input.demand.workspace, input.appearanceMetadata, input.camera,
            input.environment.diffuse, input.environment.specular, input.environment.dfg, input.lightRecords, input.clusters.parameters, input.clusters.lookup, input.clusters.data, input.clusters.activeLightList,
            input.physicalSun?.parameters ?? parameters, input.physicalSun?.transmittance ?? transport, input.shadow?.lightProjection ?? parameters, input.shadow?.virtualPageTable ?? pages, input.shadow?.physicalAtlasDepth ?? depth];
        for (const resource of reads) {
            node.read(resource);
        }
        values = node.write(values);
        node.read(input.demand.indirect);
        const arena = node.write(input.demand.arena);
        return { values, demand: { ...input.demand, arena } };
    }
    destroy(): void {
        this.parameters.destroy();
        this.pages.destroy();
        this.depth.destroy();
        this.transmittance.destroy();
        this.pipelines.clear();
    }
}
