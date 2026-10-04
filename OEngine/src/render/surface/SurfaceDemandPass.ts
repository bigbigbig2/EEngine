import type { FrameGraph } from "../../framegraph/FrameGraph.js";
import type { ResourceId } from "../../framegraph/ResourceHandle.js";
import type { ShadeGPUCommandContext } from "../../framegraph/ShadeGPUCommandContext.js";
import type { GpuAppearancePublication } from "../../gpu/GpuAppearancePublication.js";
import { surfaceDemandLayout, type SurfaceDemandLayout } from "../../gpu/GpuSurfaceDemandAbi.js";
import { surfaceDemandWgsl } from "../../shaders/surface_demand.js";
import { SurfaceFrameResources, type SurfaceResourceBinding } from "./SurfaceFrameResources.js";
export interface SurfaceDemandProducts {
    readonly workspace: ResourceId;
    readonly arena: ResourceId;
    readonly indirect: ResourceId;
    readonly settings: ResourceId;
    readonly fieldStore: ResourceId;
    readonly signalStore: ResourceId;
    readonly layout: SurfaceDemandLayout;
}
export interface SurfaceDemandInput {
    readonly workspace: ResourceId;
    readonly fieldStore: ResourceId;
    readonly signalStore: ResourceId;
    readonly metadata: ResourceId;
    readonly versions: ResourceId;
    readonly publication: GpuAppearancePublication;
    readonly targets: number;
    readonly leaves: number;
    readonly epoch: Readonly<{
        value: number;
    }>;
    readonly viewRevision: Readonly<{
        value: number;
    }>;
    readonly revisions: Readonly<{
        environment: number;
        light: number;
        shadow: number;
        sun: number;
    }>;
    readonly sun: ResourceId | null;
    readonly shadow: ResourceId | null;
    readonly firstTile: number;
    readonly width: number;
    readonly height: number;
    readonly diagnostics: boolean;
    readonly bind: SurfaceResourceBinding;
}
const STAGES = [
    ["emit_surface_requests", null], ["finalize_surface_requests", null],
    ["nominate_field_producers", 20], ["resolve_field_producers", 20],
    ["nominate_signal_producers", 24], ["resolve_signal_producers", 24],
    ["compact_surface_groups", null], ["finalize_surface_groups", null],
    ["order_material_groups", 28]
] as const;
export class SurfaceDemandPass {
    private readonly pipelines = new Map<string, readonly GPUComputePipeline[]>();
    private readonly disabledSun: GPUBuffer;
    private readonly disabledShadow: GPUBuffer;
    constructor(private readonly device: GPUDevice, private readonly scratch: SurfaceFrameResources) {
        this.disabledSun = device.createBuffer({ label: "Surface/demand disabled sun", size: 48, usage: GPUBufferUsage.UNIFORM });
        this.disabledShadow = device.createBuffer({ label: "Surface/demand disabled shadow", size: 16, usage: GPUBufferUsage.STORAGE });
    }
    addToGraph(graph: FrameGraph, input: SurfaceDemandInput): SurfaceDemandProducts {
        const programs = Math.max(1, input.publication.surfaceProgramCount);
        if (programs > 256) {
            throw new RangeError("Surface publication exceeds the negotiated 256 program profile");
        }
        const layout = surfaceDemandLayout(input.targets, programs);
        if (input.leaves > input.targets || layout.bytes > Math.min(this.device.limits.maxStorageBufferBindingSize, Number(this.device.limits.maxBufferSize))) {
            throw new RangeError("Surface demand arena exceeds its complete negotiated batch profile");
        }
        const key = `${input.targets}:${programs}`;
        let pipelines = this.pipelines.get(key);
        if (pipelines === undefined) {
            const module = this.device.createShaderModule({ label: "Surface/actual demand and unique producers", code: surfaceDemandWgsl(input.targets, programs) });
            // One explicit layout keeps stage specializations compatible. Five storage
            // inputs plus two uniforms fit the portable production resource profile.
            const visibility = GPUShaderStage.COMPUTE;
            const entries: GPUBindGroupLayoutEntry[] = [
                { binding: 0, visibility, buffer: { type: "uniform" } },
                { binding: 1, visibility, buffer: { type: "storage" } },
                { binding: 2, visibility, buffer: { type: "read-only-storage" } },
                { binding: 3, visibility, buffer: { type: "read-only-storage" } },
                { binding: 4, visibility, buffer: { type: "storage" } },
                { binding: 5, visibility, buffer: { type: "uniform" } },
                { binding: 6, visibility, buffer: { type: "read-only-storage" } }
            ];
            const pipelineLayout = this.device.createPipelineLayout({ bindGroupLayouts: [this.device.createBindGroupLayout({ entries })] });
            pipelines = Object.freeze(STAGES.map(([entryPoint]) => this.device.createComputePipeline({
                label: `Surface/${entryPoint}`, layout: pipelineLayout, compute: { module, entryPoint }
            })));
            this.pipelines.set(key, pipelines);
        }
        const sun = input.sun ?? graph.import_resource("Surface/demand disabled sun", { kind: "imported" }, input.bind("surface-demand-disabled-sun", () => this.disabledSun));
        const shadow = input.shadow ?? graph.import_resource("Surface/demand disabled shadow", { kind: "imported" }, input.bind("surface-demand-disabled-shadow", () => this.disabledShadow));
        let arena = this.scratch.importBuffer(graph, input.bind, "Surface/actual demand arena", layout.bytes, GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC);
        const indirectBytes=layout.offsets.programs!+programs*32;
        let indirect=this.scratch.importBuffer(graph,input.bind,"Surface/actual demand indirect",indirectBytes,
            GPUBufferUsage.INDIRECT|GPUBufferUsage.COPY_DST);
        let settings!: ResourceId;
        let workspace = input.workspace;
        const reset = graph.add("Surface/actual demand reset", { arena, input }, (data, resources, context) => {
            const command = context.encoder as ShadeGPUCommandContext;
            command.gpu_encoder.clearBuffer(resources.get(data.arena) as GPUBuffer);
            const offsets = data.input.publication.surfaceMetadataOffsets;
            command.writeBuffer(resources.get(settings) as GPUBuffer, 0, new Uint32Array([
                offsets.fieldIdentities, offsets.constantFields, data.input.leaves, 0,
                data.input.epoch.value, data.input.viewRevision.value, data.input.revisions.environment, data.input.revisions.light,
                data.input.revisions.shadow, data.input.revisions.sun, data.input.shadow === null ? 0 : 1, data.input.sun === null ? 0 : 1,
                0, data.input.diagnostics ? 1 : 0, 0, 0,
                offsets.directory, programs, layout.fieldCapacity, layout.signalCapacity,
                data.input.firstTile, Math.ceil(data.input.width / 8), data.input.width, data.input.height
            ]).buffer, 0, 96);
        });
        arena = reset.write(arena);
        settings = reset.create("Surface/actual demand settings", { kind: "transient_buffer", size: 96,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST, domain: "internal-full" });
        reset.read(workspace);
        let previous = reset;
        for (const [index, [entryPoint, indirectWord]] of STAGES.entries()) {
            const pipeline = pipelines[index]!;
            const node = graph.add(`Surface/${entryPoint}`, { arena, workspace,indirect }, (data, resources, context) => {
                const command = context.encoder as ShadeGPUCommandContext;
                const group = this.device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [
                        { binding: 0, resource: { buffer: resources.get(settings) as GPUBuffer } },
                        { binding: 1, resource: { buffer: resources.get(data.workspace) as GPUBuffer } },
                        { binding: 2, resource: { buffer: resources.get(input.metadata) as GPUBuffer } },
                        { binding: 3, resource: { buffer: resources.get(input.versions) as GPUBuffer } },
                        { binding: 4, resource: { buffer: resources.get(data.arena) as GPUBuffer } },
                        { binding: 5, resource: { buffer: resources.get(sun) as GPUBuffer } },
                        { binding: 6, resource: { buffer: resources.get(shadow) as GPUBuffer } }
                    ] });
                const pass = command.beginComputePass({ label: `Surface/${entryPoint}` });
                pass.setPipeline(pipeline);
                pass.setBindGroup(0, group);
                if (indirectWord !== null) {
                    pass.dispatchWorkgroupsIndirect(resources.get(data.indirect) as GPUBuffer, indirectWord * 4);
                }
                else {
                    pass.dispatchWorkgroups(entryPoint.startsWith("finalize_") ? 1 : input.leaves / 64);
                }
                pass.end();
            });
            node.read(settings);
            node.read(workspace);
            node.read(arena);
            node.read(input.metadata);
            node.read(input.versions);
            node.read(sun);
            node.read(shadow);
            arena = node.write(arena);
            if (entryPoint.startsWith("resolve_")) {
                workspace = node.write(workspace);
            }
            node.dependsOn(previous);
            previous = node;
            if(indirectWord!==null) {node.read(indirect);}
            if(entryPoint==="finalize_surface_requests" || entryPoint==="finalize_surface_groups") {
                const copy=graph.add("Surface/publish actual indirect arguments",{arena,indirect},(data,resources,context)=>{
                    (context.encoder as ShadeGPUCommandContext).gpu_encoder.copyBufferToBuffer(
                        resources.get(data.arena) as GPUBuffer,0,resources.get(data.indirect) as GPUBuffer,0,indirectBytes);
                });
                copy.read(arena);indirect=copy.write(indirect);copy.dependsOn(previous);previous=copy;
            }
        }
        return { workspace, arena,indirect, settings, fieldStore: input.fieldStore, signalStore: input.signalStore, layout };
    }
    destroy(): void { this.disabledSun.destroy(); this.disabledShadow.destroy(); this.pipelines.clear(); }
}
