import type { FrameGraph } from "../../framegraph/FrameGraph.js";
import type { ResourceId } from "../../framegraph/ResourceHandle.js";
import type { SurfaceResourceBinding } from "./SurfaceFrameResources.js";
import { SurfaceFrameResources } from "./SurfaceFrameResources.js";
import { SurfaceCellClassifierPass, type SurfaceCellClassifierProducts } from "./SurfaceCellClassifierPass.js";
import { SurfaceGeometryPass } from "./SurfaceGeometryPass.js";
import { SurfaceDemandPass } from "./SurfaceDemandPass.js";
import { SurfaceDiagnosticsPass } from "./SurfaceDiagnosticsPass.js";
import { type SurfaceDiagnosticsMode, type SurfaceDiagnosticsIdentity, SURFACE_DIAGNOSTICS_BYTE_SIZE } from "../../gpu/SurfaceDiagnosticsAbi.js";
import type { SurfaceDiagnosticsCapture } from "../../debug/SurfaceDiagnosticsCapture.js";
import type { ResourceAccounting } from "../../debug/profiling/ResourceAccounting.js";
import type { GpuAppearancePublication } from "../../gpu/GpuAppearancePublication.js";
import type { GpuSurfaceFieldStore } from "../../gpu/GpuSurfaceFieldStore.js";
import type { GpuSurfaceSignalStore } from "../../gpu/GpuSurfaceSignalStore.js";
import { planSurfaceOptimizationCapacity, type SurfaceOptimizationCapacity } from "../../gpu/SurfaceOptimizationCapacity.js";
import { SurfaceReconstructionPass, type SurfaceReconstructionProducts } from "./SurfaceReconstructionPass.js";
import { SurfaceLightingPass } from "./SurfaceLightingPass.js";
import type { SurfaceLightingInput } from "./SurfaceLightingWorkPass.js";
import { SurfaceStorePublishPass } from "./SurfaceStorePublishPass.js";
import { SurfaceDependencyEpochPass } from "./SurfaceDependencyEpochPass.js";
import type { SurfaceDemandInput } from "./SurfaceDemandPass.js";
import type { ShadeGPUCommandContext } from "../../framegraph/ShadeGPUCommandContext.js";
import { resolveTextureView } from "../RenderTargetViews.js";
export interface SurfaceWorkFrame {
    readonly generation: number;
    readonly arenaHeaderOffset: number;
    readonly directoryOffset: number;
}
export interface SurfaceSignalRevisions {
    readonly environment: number;
    readonly light: number;
    readonly shadow: number;
    readonly sun: number;
    readonly ao?: number;
}
export interface SurfaceWorkProducts {
    readonly records: ResourceId;
    readonly radiance: ResourceId;
    readonly reactiveMask: ResourceId;
    readonly diagnostics?: ResourceId;
}
export class SurfaceWorkRuntime {
    private readonly scratch: SurfaceFrameResources;
    private readonly classifier: SurfaceCellClassifierPass;
    private readonly demand: SurfaceDemandPass;
    private readonly geometry: SurfaceGeometryPass;
    private readonly reconstruction: SurfaceReconstructionPass;
    private readonly diagnostics: SurfaceDiagnosticsPass;
    private mode: SurfaceDiagnosticsMode = "off";
    private capture: SurfaceDiagnosticsCapture | null = null;
    private identity: Omit<SurfaceDiagnosticsIdentity, "frameId"> = { runId: "default", deviceEpoch: 0 };
    private prepared = false;
    private destroyed = false;
    private capacity: SurfaceOptimizationCapacity | null = null;
    private readonly lighting: SurfaceLightingPass;
    private readonly publisher: SurfaceStorePublishPass;
    private readonly dependencyEpoch: SurfaceDependencyEpochPass;
    private readonly fieldStore: GpuSurfaceFieldStore | null;
    private readonly signalStore: GpuSurfaceSignalStore | null;
    constructor(private readonly device: GPUDevice, accounting?: ResourceAccounting, fieldStore: GpuSurfaceFieldStore | null = null, signalStore: GpuSurfaceSignalStore | null = null) {
        this.fieldStore = fieldStore;
        this.signalStore = signalStore;
        this.scratch = new SurfaceFrameResources(device, accounting);
        this.classifier = new SurfaceCellClassifierPass(device, this.scratch, fieldStore, signalStore);
        this.demand = new SurfaceDemandPass(device, this.scratch);
        this.geometry = new SurfaceGeometryPass(device, this.scratch);
        this.reconstruction = new SurfaceReconstructionPass(device);
        this.lighting = new SurfaceLightingPass(device, this.scratch);
        this.publisher = new SurfaceStorePublishPass(device);
        this.dependencyEpoch = new SurfaceDependencyEpochPass(device, fieldStore);
        this.diagnostics = new SurfaceDiagnosticsPass(device, (command, source, frameId) => {
            const capture=this.capture;
            if (capture===null || this.mode!=="detailed" || command.gpu_encoder===undefined) {
                return;
            }
            const ticket=capture.encodeReadback(command.gpu_encoder,source,{...this.identity,frameId});
            if(ticket!==null) {
                command.recordReadback("surface-diagnostics",SURFACE_DIAGNOSTICS_BYTE_SIZE);
                command.onFinished.addOne(()=>capture.markSubmitted(ticket));
                command.onAborted.addOne((_context:ShadeGPUCommandContext,cause:unknown)=>capture.cancel(ticket,cause));
            }
        });
    }
    prepareFrame(width: number, height: number, publicationGeneration = 0): void {
        if (this.destroyed || this.prepared) {
            throw new Error("SurfaceWork frame is already prepared");
        }
        this.capacity=planSurfaceOptimizationCapacity(width,height,this.device.limits);
        this.scratch.prepare(width,height);
        this.reconstruction.prepareFrame(width,height,this.capacity.batchTileCapacity);
        this.fieldStore?.preparePublication(publicationGeneration);
        this.signalStore?.preparePublication(publicationGeneration);
        this.prepared=true;
    }
    capacityEvidence(): SurfaceOptimizationCapacity | null { return this.capacity; }
    setDiagnosticsMode(mode: SurfaceDiagnosticsMode): void {
        if (this.prepared) { throw new Error("Cannot change Surface diagnostics mode during a frame"); }
        this.mode=mode;
    }
    setDiagnosticsCapture(capture: SurfaceDiagnosticsCapture | null, identity: Omit<SurfaceDiagnosticsIdentity, "frameId"> = { runId: "default", deviceEpoch: 0 }): void {
        if (this.prepared) { throw new Error("Cannot change Surface diagnostics capture during a frame"); }
        this.capture=capture;
        this.identity=identity;
    }
    addToGraph(graph: FrameGraph, input: {
        visibility: ResourceId;
        arena: ResourceId;
        meshletWork: ResourceId;
        sourceHeap: ResourceId;
        vertexPayload: ResourceId;
        frameInstances: ResourceId;
        frameAttributes: ResourceId;
        camera: ResourceId;
        textureVariation: ResourceId;
        appearanceMetadata: ResourceId;
        fieldVersions: ResourceId;
        residencyVersions: ResourceId;
        materialLookup: ResourceId;
        surfaceIdentity: ResourceId;
        materials: ResourceId;
        textureBanks: readonly (readonly ResourceId[])[];
        publication: GpuAppearancePublication;
        product: Readonly<{
            heap: ResourceId;
            banks: readonly ResourceId[];
        }> | null;
        lightRecords: ResourceId;
        clusters: SurfaceLightingInput["clusters"];
        shadow: SurfaceLightingInput["shadow"];
        scalarAo: ResourceId | null;
        environment: SurfaceLightingInput["environment"];
        physicalSun: SurfaceLightingInput["physicalSun"];
        factsMask: ResourceId;
        preExposure: ResourceId;
        width: number;
        height: number;
        historyBinding: SurfaceResourceBinding;
        revisions: SurfaceSignalRevisions;
        viewRevision: Readonly<{
            value: number;
        }>;
        nonlocalRevision: Readonly<{
            value: number;
        }>;
        diagnosticFrame: Readonly<{
            value: number;
        }>;
        frame: SurfaceWorkFrame & {
            sourceGeometry: number;
            sourceMeshlet: number;
            sourceMeshletVertices: number;
            sourceMeshletTriangles: number;
            sourceVertexData: number;
        };
    }): SurfaceWorkProducts {
        if (!this.prepared || !this.capacity) {
            throw new Error("SurfaceWork graph requires a prepared capacity profile");
        }
        const bindings = new Map<string, object>();
        const originalBinding = input.historyBinding;
        const historyBinding: SurfaceResourceBinding = <T extends object>(name: string, resolve: () => T): T => {
            let binding = bindings.get(name);
            if (binding === undefined) {
                binding = originalBinding(name, resolve);
                bindings.set(name, binding);
            }
            return binding as T;
        };
        input = { ...input, historyBinding };
        const dependencies = this.dependencyEpoch.addToGraph(graph, { metadata: input.appearanceMetadata, versions: input.residencyVersions, publication: input.publication, bind: input.historyBinding,
            beforeLookup: (command, fields) => {
                if (this.fieldStore?.needsNamespaceRestart(fields) || this.signalStore?.needsNamespaceRestart()) {
                    this.fieldStore?.requestNamespaceRestart();
                    this.signalStore?.requestNamespaceRestart();
                    this.fieldStore?.encodeNamespaceRestart(command);
                    this.signalStore?.encodeNamespaceRestart(command);
                }
                this.fieldStore?.reserveDependencyNamespace(command, fields);
            }
        });
        input = { ...input, appearanceMetadata: dependencies };
        let result: SurfaceWorkProducts | undefined;
        let previous: SurfaceReconstructionProducts | undefined;
        let previousDiagnostics: ResourceId | undefined;
        const consume = (cells: SurfaceCellClassifierProducts, firstTile: number, tileCount: number, batchTiles: number): readonly ResourceId[] => {
            const runtime = this;
            const epoch = input.historyBinding("surface-submitted-epoch", () => ({
                get value() { return runtime.fieldStore?.nextSubmissionEpoch ?? runtime.signalStore?.nextSubmissionEpoch ?? 1; }
            }));
            const request: SurfaceDemandInput = { workspace: cells.workspace, activeIndirect: cells.activeIndirect, fieldStore: cells.fieldStore, signalStore: cells.signalStore,
                metadata: input.appearanceMetadata, versions: input.fieldVersions, publication: input.publication, targets: batchTiles * 64,
                leaves: tileCount * 64, epoch, viewRevision: input.viewRevision, revisions: input.revisions,
                sun: input.physicalSun?.parameters ?? null, shadow: input.shadow?.contentVersion ?? null, firstTile,
                width: input.width, height: input.height, diagnostics: this.mode === "detailed", bind: input.historyBinding };
            let demand = this.demand.addToGraph(graph, request);
            const geometry = this.geometry.addToGraph(graph, { demand, camera: input.camera, bind: input.historyBinding,
                setup: cells.setup,width: input.width,height:input.height });
            let fields = this.scratch.importBuffer(graph, input.historyBinding, "Surface/unique field values", demand.layout.fieldCapacity * 16, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC);
            const material = graph.add("Surface/unique missing Appearance fields", { geometry: geometry.records, demand, fields }, (data, resources, context) => {
                const banks = input.textureBanks.map(set => set.map(id => resolveTextureView(resources.get(id))));
                input.publication.encodeSurfaceFields(context.encoder as ShadeGPUCommandContext, {
                    geometry: resources.get(data.geometry) as GPUBuffer, demand: resources.get(data.demand.arena) as GPUBuffer,
                    indirect:resources.get(data.demand.indirect) as GPUBuffer,
                    values: resources.get(data.fields) as GPUBuffer, layout: data.demand.layout, textureBanks: banks
                });
            });
            for (const resource of [geometry.records, demand.arena, demand.workspace, input.appearanceMetadata]) {
                material.read(resource);
            }
            for (const set of input.textureBanks) {
                for (const resource of set) {
                    material.read(resource);
                }
            }
            fields = material.write(fields);
            material.read(demand.indirect);
            demand = this.publisher.addToGraph(graph, { ...request, demand, values: fields, signal: false,
                entries: this.fieldStore?.capacity.entries ?? 4, enabled: this.fieldStore !== null });
            const lighting = this.lighting.addToGraph(graph, { resourceBinding: input.historyBinding, demand, geometry: geometry.records, fields,
                appearanceMetadata: input.appearanceMetadata, constantFieldsOffset: input.publication.surfaceMetadataOffsets.constantFields,
                width: input.width, height: input.height, frame: input.frame.generation, camera: input.camera,
                physicalSun: input.physicalSun, lightRecords: input.lightRecords, clusters: input.clusters, shadow: input.shadow,
                scalarAo: input.scalarAo, environment: input.environment, diagnosticsEnabled: this.mode === "detailed" });
            demand = this.publisher.addToGraph(graph, { ...request, demand: lighting.demand, values: lighting.values, signal: true,
                entries: this.signalStore?.capacity.entries ?? 4, enabled: this.signalStore !== null });
            const reconstructed = this.reconstruction.addToGraph(graph, { signalValues: lighting.values, signalStore: demand.signalStore,
                fieldStore: demand.fieldStore, fields, reactive: input.factsMask, preExposure: input.preExposure,
                cellWorkspace: demand.workspace, cellBatchTiles: batchTiles, activeIndirect: cells.activeIndirect, coverage: cells.coverage,
                firstTile, appearanceMetadata: input.appearanceMetadata,
                constantFieldsOffset: input.publication.surfaceMetadataOffsets.constantFields, scalarAo: input.scalarAo,
                width: input.width, height: input.height, recordCount: request.targets, diagnosticsEnabled: this.mode === "detailed",
                batch: { index: firstTile / batchTiles, batchTiles }, previous });
            previous = reconstructed;
            const diagnostics = this.mode === "detailed" ? this.diagnostics.addToGraph(graph, { demand, reconstruct: reconstructed.counters,
                after: reconstructed.radiance, width: input.width, height: input.height, firstTile, tileCount,
                last: firstTile + tileCount === this.capacity!.tileCount, frameId: input.diagnosticFrame, previous: previousDiagnostics }) : null;
            previousDiagnostics = diagnostics?.snapshot;
            result = { records: geometry.records, radiance: reconstructed.radiance, reactiveMask: reconstructed.reactiveMask,
                ...(diagnostics === null ? {} : { diagnostics: diagnostics.snapshot }) };
            return [reconstructed.radiance, reconstructed.reactiveMask, demand.fieldStore, demand.signalStore, ...(diagnostics === null ? [] : [diagnostics.snapshot])];
        };
        this.classifier.addToGraph(graph, { resourceBinding: input.historyBinding, geometryPass: this.geometry, visibility: input.visibility, meshletWork: input.meshletWork, sourceHeap: input.sourceHeap, vertexPayload: input.vertexPayload, frameInstances: input.frameInstances, camera: input.camera, textureVariation: input.textureVariation, appearanceMetadata: input.appearanceMetadata, fieldVersions: input.fieldVersions, viewRevision: input.viewRevision, signalRevisions: input.revisions, sun: input.physicalSun?.parameters ?? null, solarTransmittance: input.physicalSun?.transmittance ?? null, shadowVersion: input.shadow?.contentVersion ?? null, width: input.width, height: input.height, generation: input.frame.generation, frameAt: input.frame.arenaHeaderOffset / 4, directoryAt: input.frame.directoryOffset / 4, sourceGeometry: input.frame.sourceGeometry, sourceMeshlet: input.frame.sourceMeshlet, sourceMeshletVertices: input.frame.sourceMeshletVertices, sourceMeshletTriangles: input.frame.sourceMeshletTriangles, sourceVertexData: input.frame.sourceVertexData, publication: input.publication, product: input.product, lightRecords: input.lightRecords, clusters: input.clusters, shadowEnabled: input.shadow !== null, physicalSunEnabled: input.physicalSun !== null, targetCapacity: this.capacity.batchTargetCapacity, diagnosticsEnabled: this.mode === "detailed", consumeBatch: consume });
        if (!result) {
            throw new Error("Surface classifier did not produce a batch");
        }
        return result;
    }
    commit(gpuDone: Promise<void>, publicationGeneration = 0): void {
        if (!this.prepared) { throw new Error("SurfaceWork commit without prepare"); }
        this.reconstruction.commit();
        this.scratch.commit(gpuDone);
        this.fieldStore?.trackSubmission(gpuDone,publicationGeneration);
        this.signalStore?.trackSubmission(gpuDone,publicationGeneration);
        this.prepared=false;
    }
    abort(): void { this.reconstruction.abort(); this.prepared = false; }
    invalidate(): void { this.reconstruction.invalidate(); }
    destroy(): void {
        if (this.destroyed) { return; }
        this.destroyed=true;
        this.scratch.destroy();
        this.classifier.destroy();
        this.demand.destroy();
        this.geometry.destroy();
        this.reconstruction.destroy();
        this.lighting.destroy();
        this.publisher.destroy();
        this.dependencyEpoch.destroy();
        this.diagnostics.destroy();
    }
}
