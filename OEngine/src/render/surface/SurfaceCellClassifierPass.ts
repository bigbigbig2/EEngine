import type { FrameGraph } from "../../framegraph/FrameGraph.js";
import type { ResourceId } from "../../framegraph/ResourceHandle.js";
import type { ShadeGPUCommandContext } from "../../framegraph/ShadeGPUCommandContext.js";
import { surfaceCellClassifyStageWgsl } from "../../shaders/surface_cell_classify.js";
import { surfaceCellProductionFactsWgsl } from "../../shaders/surface_cell_production_facts.js";
import { SURFACE_CELL_LIGHTING_RISK_WGSL } from "../../shaders/surface_cell_lighting_risk.js";
import { SURFACE_CELL_STATIC_PRODUCT_BOUNDS_WGSL } from "../../shaders/surface_cell_static_product_bounds.js";
import {
  SURFACE_CELL_PLANE_COUNT,
  SURFACE_CELL_TILE_PLAN_BYTES,
  surfaceCellWorkspaceLayout,
  surfaceCellWorkspaceWgsl,
  surfaceCellWorkspaceResetRanges,
} from "../../gpu/GpuSurfaceCellPlanAbi.js";
import type { GpuAppearancePublication } from "../../gpu/GpuAppearancePublication.js";
import type { SurfaceResourceBinding } from "./SurfaceFrameResources.js";
import { SurfaceFrameResources } from "./SurfaceFrameResources.js";
import { planSurfaceCellGeometryCapacity } from "../../gpu/GpuSurfaceCellGeometryAbi.js";
import { createSurfaceCellPipelineLayout } from "./SurfaceCellPipelineLayout.js";
import {
  SURFACE_CELL_CLASSIFY_STAGES,
  SURFACE_CELL_CERTIFICATE_FAMILIES,
} from "../../shaders/surface_cell_group_validation.js";
import type { SurfaceGeometryPass } from "./SurfaceGeometryPass.js";
import type { SurfaceCellGeometrySetupProducts } from "./SurfaceCellGeometrySetup.js";
import type { GpuSurfaceFieldStore } from "../../gpu/GpuSurfaceFieldStore.js";
import { SurfaceFieldLookupPass } from "./SurfaceFieldLookupPass.js";
import type { GpuSurfaceSignalStore } from "../../gpu/GpuSurfaceSignalStore.js";
import { SurfaceSignalLookupPass, type SurfaceSignalLookupInput } from "./SurfaceSignalLookupPass.js";
import { SurfaceCoveragePass } from "./SurfaceCoveragePass.js";
import { SurfaceRadiometryPass } from "./SurfaceRadiometryPass.js";

/**
 * The production cell classifier owns the complete coverage -> cell plan
 * boundary. It emits compact SurfaceSampleRecord representatives directly;
 * there is no old winner-equality classifier or pixel-task expansion stage.
 * FieldStore and SignalStore consume these representatives as the bounded
 * per-frame demand stream; they do not recreate dense pixel products.
 */
export interface SurfaceCellClassifierInput {
  readonly resourceBinding: SurfaceResourceBinding;
  readonly geometryPass: SurfaceGeometryPass;
  readonly visibility: ResourceId;
  readonly meshletWork: ResourceId;
  readonly sourceHeap: ResourceId;
  readonly vertexPayload: ResourceId;
  readonly frameInstances: ResourceId;
  readonly camera: ResourceId;
  readonly textureVariation: ResourceId;
  readonly appearanceMetadata: ResourceId;
  readonly fieldVersions: ResourceId;
  readonly viewRevision: Readonly<{ value: number }>;
  readonly signalRevisions: SurfaceSignalLookupInput["revisions"];
  readonly sun: ResourceId | null;
  readonly solarTransmittance?: ResourceId | null;
  readonly shadowVersion: ResourceId | null;
  readonly width: number;
  readonly height: number;
  readonly generation: number;
  readonly frameAt: number;
  readonly directoryAt: number;
  readonly sourceGeometry: number;
  readonly sourceMeshlet: number;
  readonly sourceMeshletVertices: number;
  readonly sourceMeshletTriangles: number;
  readonly sourceVertexData: number;
  readonly publication: GpuAppearancePublication;
  readonly product: Readonly<{ heap: ResourceId; banks: readonly ResourceId[] }> | null;
  readonly lightRecords: ResourceId;
  readonly clusters: Readonly<{ parameters: ResourceId; lookup: ResourceId; data: ResourceId }>;
  readonly shadowEnabled: boolean;
  readonly physicalSunEnabled: boolean;
  readonly targetCapacity: number;
  readonly diagnosticsEnabled: boolean;
  /** Consume and reconstruct each bounded batch before its scratch is reused. */
  readonly consumeBatch?: (
    products: SurfaceCellClassifierProducts,
    firstTile: number,
    tileCount: number,
    batchTiles: number,
  ) => readonly ResourceId[];
}

export interface SurfaceCellClassifierProducts {
  readonly setup: SurfaceCellGeometrySetupProducts;
  readonly coverage: ResourceId;
  readonly activeIndirect: ResourceId;
  readonly workspace: ResourceId;
  readonly fieldStore: ResourceId;
  readonly signalStore: ResourceId;
  readonly batchTileCapacity: number;
}

export class SurfaceCellClassifierPass {
  private readonly fieldLookup: SurfaceFieldLookupPass;
  private readonly signalLookup: SurfaceSignalLookupPass;
  private readonly cellSettings: GPUBuffer;
  private readonly factSettings: GPUBuffer;
  private readonly scratch: SurfaceFrameResources;
  private readonly coveragePass: SurfaceCoveragePass;
  private readonly radiometry: SurfaceRadiometryPass;
  private readonly pipelines = new Map<
    string,
    Readonly<{
      constants: GPUComputePipeline;
      facts: GPUComputePipeline;
      addresses: GPUComputePipeline;
      signalWitnesses: GPUComputePipeline;
      prepareProofs: GPUComputePipeline;
      finalizeProofs: GPUComputePipeline;
      geometryCertificates: GPUComputePipeline;
      fieldCertificates: readonly GPUComputePipeline[];
      classify: readonly GPUComputePipeline[];
    }>
  >();

  constructor(
    private readonly device: GPUDevice,
    scratch: SurfaceFrameResources,
    fieldStore: GpuSurfaceFieldStore | null = null,
    signalStore: GpuSurfaceSignalStore | null = null,
  ) {
    this.scratch = scratch;
    this.coveragePass = new SurfaceCoveragePass(device, scratch);
    this.radiometry = new SurfaceRadiometryPass(device, scratch);
    this.fieldLookup = new SurfaceFieldLookupPass(device, fieldStore, scratch);
    this.signalLookup = new SurfaceSignalLookupPass(device, signalStore, scratch);
    this.cellSettings = device.createBuffer({
      label: "Surface/cell settings",
      size: 32,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.factSettings = device.createBuffer({
      label: "Surface/cell fact settings",
      size: 112,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
  }

  addToGraph(graph: FrameGraph, input: SurfaceCellClassifierInput): SurfaceCellClassifierProducts {
    const tilesX = Math.ceil(input.width / 8),
      tilesY = Math.ceil(input.height / 8),
      tiles = tilesX * tilesY;
    const targetCapacity = input.targetCapacity;
    const batchTileCapacity = Math.max(1, Math.floor(targetCapacity / 64));
    const resetRanges = surfaceCellWorkspaceResetRanges(batchTileCapacity);
    const workspaceLayout = surfaceCellWorkspaceLayout(batchTileCapacity);
    if (workspaceLayout.bytes > this.device.limits.maxStorageBufferBindingSize) {
      throw new RangeError(
        "Surface cell workspace exceeds the negotiated storage binding limit; batch splitting is required",
      );
    }
    const geometryCapacity = planSurfaceCellGeometryCapacity(
      input.targetCapacity,
      input.targetCapacity * 1280,
      this.device.limits,
    );
    const { referenceCapacity, setupCapacity } = geometryCapacity;
    const product = input.product !== null;
    const factLibrary = surfaceCellProductionFactsWgsl(
      input.publication.surfaceBoundPrograms,
      product,
      SURFACE_CELL_LIGHTING_RISK_WGSL,
      product ? SURFACE_CELL_STATIC_PRODUCT_BOUNDS_WGSL : null,
      referenceCapacity,
      new Set(),
      true,
    );
    // Extent and first/tile count are uniforms. Only the bounded workspace and
    // publication shape change generated code; resize must not recompile the
    // same heavy certificate shaders just because the total tile count changed.
    const profile =
      `${product}:${referenceCapacity}:${input.publication.surfaceProgramCount}:` +
      `${input.publication.surfaceCacheGeneration}:${input.targetCapacity}`;
    let pipelines = this.pipelines.get(profile);
    if (!pipelines) {
      const productionLayout = createSurfaceCellPipelineLayout(this.device, product);
      const fullModule = this.device.createShaderModule({
        label: "Surface/cell publication and compaction",
        code: `${surfaceCellClassifyStageWgsl(factLibrary, batchTileCapacity, 0, 0, 3, "classify_cells_base", false)}`,
      });
      const fieldModules = SURFACE_CELL_CERTIFICATE_FAMILIES.flatMap((fields, family) =>
        [true, false].map((parameterBounds) => {
          const fieldFacts = surfaceCellProductionFactsWgsl(
            input.publication.surfaceBoundPrograms,
            product,
            SURFACE_CELL_LIGHTING_RISK_WGSL,
            product ? SURFACE_CELL_STATIC_PRODUCT_BOUNDS_WGSL : null,
            referenceCapacity,
            new Set(fields),
            false,
            parameterBounds,
            1 + family * 2 + (parameterBounds ? 0 : 1),
          );
          return {
            entryPoint: parameterBounds
              ? "publish_cell_parameter_certificates"
              : "publish_cell_field_certificates",
            module: this.device.createShaderModule({
              label: `Surface/shared field certificates family ${family}`,
              code: surfaceCellClassifyStageWgsl(
                fieldFacts,
                batchTileCapacity,
                0,
                0,
                0,
                "unused_field_classifier",
                false,
              ),
            }),
          };
        }),
      );
      const modules = SURFACE_CELL_CLASSIFY_STAGES.map(({ first: start, count }, index) => {
        const stageFacts = surfaceCellProductionFactsWgsl(
          input.publication.surfaceBoundPrograms,
          product,
          SURFACE_CELL_LIGHTING_RISK_WGSL,
          product ? SURFACE_CELL_STATIC_PRODUCT_BOUNDS_WGSL : null,
          referenceCapacity,
          new Set(),
          false,
        );
        return this.device.createShaderModule({
          label: `Surface/cell production classifier stage ${index}`,
          code: surfaceCellClassifyStageWgsl(
            stageFacts,
            batchTileCapacity,
            index,
            start,
            count,
            `classify_cells_stage_${index}`,
            start < 15 ? "field-geometry" : "full",
          ),
        });
      });
      const module = fullModule;
      pipelines = Object.freeze({
        constants: this.device.createComputePipeline({
          label: "Surface/cell material constants",
          layout: "auto",
          compute: { module, entryPoint: "publish_cell_material_constants" },
        }),
        facts: this.device.createComputePipeline({
          label: "Surface/cell lighting facts",
          layout: productionLayout,
          compute: { module, entryPoint: "publish_cell_facts" },
        }),
        addresses: this.device.createComputePipeline({
          label: "Surface/canonical field addresses",
          layout: productionLayout,
          compute: { module, entryPoint: "publish_cell_addresses" },
        }),
        signalWitnesses: this.device.createComputePipeline({
          label: "Surface/admitted signal witnesses",
          layout: productionLayout,
          compute: { module, entryPoint: "publish_cell_signal_witnesses" },
        }),
        prepareProofs: this.device.createComputePipeline({
          label: "Surface/actual proof family tiles",
          layout: productionLayout,
          compute: { module, entryPoint: "prepare_cell_proof_tiles" },
        }),
        finalizeProofs: this.device.createComputePipeline({
          label: "Surface/finalize proof family tiles",
          layout: productionLayout,
          compute: { module, entryPoint: "finalize_cell_proof_tiles" },
        }),
        geometryCertificates: this.device.createComputePipeline({
          label: "Surface/shared geometry certificates",
          layout: productionLayout,
          compute: { module, entryPoint: "publish_cell_geometry_certificates" },
        }),
        fieldCertificates: Object.freeze(
          fieldModules.map(({ module, entryPoint }, index) =>
            this.device.createComputePipeline({
              label: `Surface/${entryPoint} family ${Math.floor(index / 2)}`,
              layout: productionLayout,
              compute: { module, entryPoint },
            }),
          ),
        ),
        classify: Object.freeze(
          modules.map((stageModule, index) =>
            this.device.createComputePipeline({
              label: `Surface/cell classify stage ${index}`,
              layout: productionLayout,
              compute: { module: stageModule, entryPoint: `classify_cells_stage_${index}` },
            }),
          ),
        ),
      });
      this.pipelines.set(profile, pipelines);
    }

    const batchCount = Math.ceil(tiles / batchTileCapacity);
    const coverage = this.coveragePass.addToGraph(graph, {
      visibility: input.visibility,
      meshletWork: input.meshletWork,
      metadata: input.appearanceMetadata,
      publication: input.publication,
      width: input.width,
      height: input.height,
      generation: input.generation,
      bind: input.resourceBinding,
    });
    let activeIndirect!: ResourceId;
    const batchWorkspaceLayout = surfaceCellWorkspaceLayout(batchTileCapacity);
    let workspace = this.scratch.importBuffer(
      graph,
      input.resourceBinding,
      "Surface/cell plan workspace",
      batchWorkspaceLayout.bytes,
      GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
    );
    let fieldStore!: ResourceId, signalStore!: ResourceId;
    this.radiometry.addToGraph(graph, {
      metadata: input.appearanceMetadata,
      offset: input.publication.surfaceMetadataOffsets.radiometry,
      lightRecords: input.lightRecords,
      clusters: input.clusters.data,
      sun: input.sun,
      transmittance: input.solarTransmittance ?? null,
    });
    const constants = graph.add(
      "Surface/cell publish material constants",
      { input, workspace },
      (_data, resources, context) => {
        const command = context.encoder as ShadeGPUCommandContext;
        const metadata = input.publication.surfaceMetadataOffsets;
        // Match CellFactSettings vec4 blocks, before the first publication read.
        const settings = new Uint32Array([
          input.sourceGeometry,
          input.sourceMeshlet,
          input.sourceMeshletVertices,
          input.sourceMeshletTriangles,
          input.sourceVertexData,
          0,
          0,
          0,
          metadata.constants,
          metadata.routes,
          metadata.bounds,
          metadata.directory,
          metadata.materialLookup,
          metadata.materialLookupCount,
          metadata.directoryCount,
          input.publication.surfaceCacheGeneration,
          referenceCapacity,
          setupCapacity,
          input.generation,
          1,
          metadata.constantFields,
          (input.shadowEnabled ? 1 : 0) | (input.physicalSunEnabled ? 2 : 0),
          metadata.fieldIdentities,
          metadata.executionProfiles,
          metadata.radiometry,
          0,
          0,
          0,
        ]);
        command.writeBuffer(this.factSettings, 0, settings.buffer, 0, settings.byteLength);
        const pass = command.beginComputePass({ label: "Surface/cell publish material constants" });
        pass.setPipeline(pipelines!.constants);
        pass.setBindGroup(
          1,
          this.scratch.obtainBindGroup(pipelines!.constants, 1, [
            { binding: 0, resource: { buffer: this.factSettings } },
            { binding: 7, resource: { buffer: resources.get(input.appearanceMetadata) as GPUBuffer } },
          ]),
        );
        pass.dispatchWorkgroups(Math.ceil(metadata.directoryCount / 64));
        pass.end();
      },
    );
    constants.read(input.appearanceMetadata);
    constants.write(input.appearanceMetadata);

    const bindFactGroups = (
      pipeline: GPUComputePipeline,
      resources: { get(id: ResourceId): unknown },
      setup: SurfaceCellGeometrySetupProducts,
    ): readonly GPUBindGroup[] => {
      const group0: GPUBindGroupEntry[] = [
        { binding: 0, resource: { buffer: this.cellSettings } },
        { binding: 1, resource: this.scratch.resolveTextureView(resources.get(input.visibility)) },
        { binding: 2, resource: { buffer: resources.get(workspace) as GPUBuffer } },
      ];
      const group1: GPUBindGroupEntry[] = [
        { binding: 0, resource: { buffer: this.factSettings } },
        { binding: 1, resource: { buffer: resources.get(setup.arena) as GPUBuffer } },
        { binding: 3, resource: { buffer: resources.get(input.meshletWork) as GPUBuffer } },
        { binding: 4, resource: { buffer: resources.get(input.sourceHeap) as GPUBuffer } },
        { binding: 5, resource: { buffer: resources.get(input.vertexPayload) as GPUBuffer } },
        { binding: 6, resource: { buffer: resources.get(input.frameInstances) as GPUBuffer } },
        { binding: 7, resource: { buffer: resources.get(input.appearanceMetadata) as GPUBuffer } },
        { binding: 8, resource: { buffer: resources.get(input.textureVariation) as GPUBuffer } },
        { binding: 14, resource: { buffer: resources.get(input.camera) as GPUBuffer } },
      ];
      if (input.product !== null) {
        group1.push({ binding: 9, resource: { buffer: resources.get(input.product.heap) as GPUBuffer } });
        input.product.banks.forEach((id, i) =>
          group1.push({ binding: i + 10, resource: { buffer: resources.get(id) as GPUBuffer } }),
        );
      }
      const group2: GPUBindGroupEntry[] = [
        { binding: 0, resource: { buffer: resources.get(input.lightRecords) as GPUBuffer } },
        { binding: 1, resource: { buffer: resources.get(input.clusters.lookup) as GPUBuffer } },
        { binding: 2, resource: { buffer: resources.get(input.clusters.data) as GPUBuffer } },
        { binding: 3, resource: { buffer: resources.get(input.clusters.parameters) as GPUBuffer } },
      ];
      return [
        this.scratch.obtainBindGroup(pipeline, 0, group0),
        this.scratch.obtainBindGroup(pipeline, 1, group1),
        this.scratch.obtainBindGroup(pipeline, 2, group2),
      ];
    };
    let previous = constants;
    let consumed: readonly ResourceId[] = [];
    let lastSetup!: SurfaceCellGeometrySetupProducts;
    for (let batch = 0; batch < batchCount; batch++) {
      const firstTile = batch * batchTileCapacity;
      const tileCount = Math.min(batchTileCapacity, tiles - firstTile);
      const batchReset = graph.add(
        `Surface/cell batch ${batch} workspace reset`,
        { firstTile, tileCount },
        (_data, resources, context) => {
          const command = context.encoder as ShadeGPUCommandContext;
          const buffer = resources.get(workspace) as GPUBuffer;
          for (const [offset, bytes] of resetRanges) {
            command.gpu_encoder.clearBuffer(buffer, offset, bytes);
          }
          command.writeBuffer(
            this.cellSettings,
            0,
            new Uint32Array([
              input.width,
              input.height,
              tilesX,
              firstTile,
              tileCount,
              input.targetCapacity,
              input.generation,
              input.diagnosticsEnabled ? 1 : 0,
            ]).buffer,
            0,
            32,
          );
        },
      );
      for (const resource of consumed) {
        batchReset.read(resource);
      }
      batchReset.read(workspace);
      workspace = batchReset.write(workspace);
      batchReset.dependsOn(previous);
      const range = this.coveragePass.addRangeToGraph(graph, {
        coverage,
        workspace,
        first: firstTile,
        capacity: tileCount,
        tiles,
        tilesX,
        after: consumed,
        bind: input.resourceBinding,
      });
      workspace = range.workspace;
      activeIndirect = range.indirect;
      const setup = input.geometryPass.addCellSetupsToGraph(graph, {
        resourceBinding: input.resourceBinding,
        visibility: input.visibility,
        meshletWork: input.meshletWork,
        sourceHeap: input.sourceHeap,
        vertexPayload: input.vertexPayload,
        frameInstances: input.frameInstances,
        product: input.product,
        width: input.width,
        height: input.height,
        tilesX,
        firstTile,
        tileCount,
        workspace,
        activeIndirect,
        targetCapacity: input.targetCapacity,
        after: [workspace, activeIndirect],
        addressBudgetBytes: input.targetCapacity * 1280,
        generation: input.generation,
        sourceGeometry: input.sourceGeometry,
        sourceMeshlet: input.sourceMeshlet,
        sourceMeshletVertices: input.sourceMeshletVertices,
        sourceMeshletTriangles: input.sourceMeshletTriangles,
        sourceVertexData: input.sourceVertexData,
      });
      lastSetup = setup;
      const facts = graph.add(
        `Surface/cell publish geometry and lighting facts batch ${batch}`,
        { setup, workspace },
        (_data, resources, context) => {
          const command = context.encoder as ShadeGPUCommandContext;
          const pass = command.beginComputePass({
            label: "Surface/cell publish geometry and lighting facts",
          });
          pass.setPipeline(pipelines!.facts);
          bindFactGroups(pipelines!.facts, resources, setup).forEach((group, index) =>
            pass.setBindGroup(index, group),
          );
          pass.dispatchWorkgroupsIndirect(resources.get(activeIndirect) as GPUBuffer, 0);
          pass.end();
        },
      );
      facts.read(input.visibility);
      facts.read(setup.arena);
      facts.read(input.meshletWork);
      facts.read(input.sourceHeap);
      facts.read(input.vertexPayload);
      facts.read(input.frameInstances);
      facts.read(input.appearanceMetadata);
      facts.read(input.textureVariation);
      facts.read(input.camera);
      facts.read(input.lightRecords);
      facts.read(input.clusters.lookup);
      facts.read(input.clusters.data);
      facts.read(input.clusters.parameters);
      facts.read(workspace);
      workspace = facts.write(workspace);
      facts.dependsOn(batchReset);
      facts.read(setup.memo);
      facts.read(activeIndirect);
      previous = facts;
      const addresses = graph.add(
        `Surface/canonical field addresses batch ${batch}`,
        { setup, workspace },
        (_data, resources, context) => {
          const command = context.encoder as ShadeGPUCommandContext;
          const pass = command.beginComputePass({ label: "Surface/canonical field addresses" });
          pass.setPipeline(pipelines!.addresses);
          bindFactGroups(pipelines!.addresses, resources, setup).forEach((group, index) =>
            pass.setBindGroup(index, group),
          );
          pass.dispatchWorkgroupsIndirect(resources.get(activeIndirect) as GPUBuffer, 0);
          pass.end();
        },
      );
      addresses.read(input.visibility);
      addresses.read(setup.arena);
      addresses.read(input.meshletWork);
      addresses.read(activeIndirect);
      addresses.read(input.sourceHeap);
      addresses.read(input.vertexPayload);
      addresses.read(input.frameInstances);
      addresses.read(input.appearanceMetadata);
      addresses.read(input.textureVariation);
      addresses.read(input.camera);
      addresses.read(input.lightRecords);
      addresses.read(input.clusters.lookup);
      addresses.read(input.clusters.data);
      addresses.read(input.clusters.parameters);
      if (input.product !== null) {
        addresses.read(input.product.heap);
        for (const bank of input.product.banks) {
          addresses.read(bank);
        }
      }
      addresses.read(workspace);
      workspace = addresses.write(workspace);
      addresses.dependsOn(previous);
      const lookedUp = this.fieldLookup.addToGraph(graph, {
        workspace,
        activeIndirect,
        geometry: setup.arena,
        referenceCapacity: setup.referenceCapacity,
        width: input.width,
        height: input.height,
        metadata: input.appearanceMetadata,
        versions: input.fieldVersions,
        publication: input.publication,
        batchTiles: batchTileCapacity,
        tileCount,
        viewRevision: input.viewRevision,
        diagnostics: input.diagnosticsEnabled,
        bind: input.resourceBinding,
      });
      workspace = lookedUp.workspace;
      fieldStore = lookedUp.store;
      let proofIndirect = this.scratch.importBuffer(
        graph,
        input.resourceBinding,
        "Surface/proof family indirect",
        7 * 16,
        GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST,
      );
      const proofTiles = graph.add(
        `Surface/actual proof family tiles batch ${batch}`,
        { workspace },
        (_data, resources, context) => {
          const command = context.encoder as ShadeGPUCommandContext;
          let pass = command.beginComputePass({ label: "Surface/actual proof family tiles" });
          pass.setPipeline(pipelines!.prepareProofs);
          bindFactGroups(pipelines!.prepareProofs, resources, setup).forEach((group, index) =>
            pass.setBindGroup(index, group),
          );
          pass.dispatchWorkgroupsIndirect(resources.get(activeIndirect) as GPUBuffer, 0);
          pass.end();
          pass = command.beginComputePass({ label: "Surface/finalize proof family tiles" });
          pass.setPipeline(pipelines!.finalizeProofs);
          bindFactGroups(pipelines!.finalizeProofs, resources, setup).forEach((group, index) =>
            pass.setBindGroup(index, group),
          );
          pass.dispatchWorkgroups(1);
          pass.end();
          command.gpu_encoder.copyBufferToBuffer(
            resources.get(workspace) as GPUBuffer,
            batchWorkspaceLayout.proofDispatch,
            resources.get(proofIndirect) as GPUBuffer,
            0,
            7 * 16,
          );
        },
      );
      for (const resource of [
        workspace,
        setup.arena,
        activeIndirect,
        input.visibility,
        input.camera,
        input.appearanceMetadata,
        input.meshletWork,
        input.sourceHeap,
        input.vertexPayload,
        input.frameInstances,
        input.textureVariation,
        input.lightRecords,
        input.clusters.lookup,
        input.clusters.data,
        input.clusters.parameters,
      ]) {
        proofTiles.read(resource);
      }
      workspace = proofTiles.write(workspace);
      proofIndirect = proofTiles.write(proofIndirect);
      previous = addresses;
      const certificateStages = [
        ["geometry", pipelines.geometryCertificates],
        ...pipelines.fieldCertificates.map(
          (pipeline, family) => [`field and texture family ${family}`, pipeline] as const,
        ),
      ] as const;
      for (const [queue, [name, pipeline]] of certificateStages.entries()) {
        const certificate = graph.add(
          `Surface/shared ${name} certificates batch ${batch}`,
          { setup, workspace },
          (_data, resources, context) => {
            const command = context.encoder as ShadeGPUCommandContext;
            const pass = command.beginComputePass({ label: `Surface/shared ${name} certificates` });
            pass.setPipeline(pipeline);
            bindFactGroups(pipeline, resources, setup).forEach((group, index) =>
              pass.setBindGroup(index, group),
            );
            pass.dispatchWorkgroupsIndirect(resources.get(proofIndirect) as GPUBuffer, queue * 16);
            pass.end();
          },
        );
        certificate.read(input.visibility);
        certificate.read(setup.arena);
        certificate.read(input.meshletWork);
        certificate.read(setup.memo);
        certificate.read(activeIndirect);
        certificate.read(proofIndirect);
        certificate.read(input.sourceHeap);
        certificate.read(input.vertexPayload);
        certificate.read(input.frameInstances);
        certificate.read(input.appearanceMetadata);
        certificate.read(input.textureVariation);
        certificate.read(input.camera);
        certificate.read(input.lightRecords);
        certificate.read(input.clusters.lookup);
        certificate.read(input.clusters.data);
        certificate.read(input.clusters.parameters);
        if (input.product !== null) {
          certificate.read(input.product.heap);
          for (const bank of input.product.banks) {
            certificate.read(bank);
          }
        }
        certificate.read(workspace);
        workspace = certificate.write(workspace);
        certificate.dependsOn(previous);
        previous = certificate;
      }
      for (const [stageIndex, pipeline] of pipelines!.classify.entries()) {
        const classify = graph.add(
          `Surface/cell classify continuity domains ${stageIndex} batch ${batch}`,
          { setup, workspace },
          (_data, resources, context) => {
            const command = context.encoder as ShadeGPUCommandContext;
            const pass = command.beginComputePass({
              label: `Surface/cell classify continuity domains ${stageIndex}`,
            });
            pass.setPipeline(pipeline);
            bindFactGroups(pipeline, resources, setup).forEach((group, index) =>
              pass.setBindGroup(index, group),
            );
            pass.dispatchWorkgroupsIndirect(resources.get(activeIndirect) as GPUBuffer, 0);
            pass.end();
          },
        );
        classify.read(input.visibility);
        classify.read(setup.arena);
        classify.read(input.meshletWork);
        classify.read(input.sourceHeap);
        classify.read(input.vertexPayload);
        classify.read(input.frameInstances);
        classify.read(input.appearanceMetadata);
        classify.read(input.textureVariation);
        classify.read(input.camera);
        classify.read(input.lightRecords);
        classify.read(input.clusters.lookup);
        classify.read(input.clusters.data);
        classify.read(input.clusters.parameters);
        classify.read(workspace);
        workspace = classify.write(workspace);
        classify.dependsOn(previous as any);
        previous = classify;
        classify.read(setup.memo);
        classify.read(activeIndirect);
        if (stageIndex === 0) {
          const witnesses = graph.add(
            `Surface/admitted signal witnesses batch ${batch}`,
            { workspace },
            (_data, resources, context) => {
              const command = context.encoder as ShadeGPUCommandContext;
              const pass = command.beginComputePass({ label: "Surface/admitted signal witnesses" });
              pass.setPipeline(pipelines!.signalWitnesses);
              bindFactGroups(pipelines!.signalWitnesses, resources, setup).forEach((group, index) =>
                pass.setBindGroup(index, group),
              );
              pass.dispatchWorkgroupsIndirect(resources.get(activeIndirect) as GPUBuffer, 0);
              pass.end();
            },
          );
          for (const resource of [
            setup.arena,
            input.camera,
            input.appearanceMetadata,
            input.visibility,
            input.meshletWork,
            input.sourceHeap,
            input.vertexPayload,
            input.frameInstances,
            input.textureVariation,
            input.lightRecords,
            input.clusters.lookup,
            input.clusters.data,
            input.clusters.parameters,
            activeIndirect,
            workspace,
          ]) {
            witnesses.read(resource);
          }
          workspace = witnesses.write(workspace);
          witnesses.dependsOn(previous);
          previous = witnesses;
          const lookedUpSignals = this.signalLookup.addToGraph(graph, {
            workspace,
            activeIndirect,
            metadata: input.appearanceMetadata,
            versions: input.fieldVersions,
            publication: input.publication,
            batchTiles: batchTileCapacity,
            tileCount,
            viewRevision: input.viewRevision,
            revisions: input.signalRevisions,
            sun: input.sun,
            shadowVersion: input.shadowVersion,
            shadowEnabled: input.shadowEnabled,
            diagnostics: input.diagnosticsEnabled,
            bind: input.resourceBinding,
          });
          workspace = lookedUpSignals.workspace;
          signalStore = lookedUpSignals.store;
        }
      }
      if (input.consumeBatch !== undefined) {
        consumed = input.consumeBatch(
          { workspace, fieldStore, signalStore, batchTileCapacity, coverage, activeIndirect, setup },
          firstTile,
          tileCount,
          batchTileCapacity,
        );
        const complete = graph.add(`Surface/cell batch ${batch} consumed`, {}, () => {});
        for (const resource of consumed) {
          complete.read(resource);
        }
        complete.make_side_effect();
        previous = complete;
      }
    }
    return {
      workspace,
      fieldStore,
      signalStore,
      batchTileCapacity,
      coverage,
      activeIndirect,
      setup: lastSetup,
    };
  }

  destroy(): void {
    this.radiometry.destroy();
    this.fieldLookup.destroy();
    this.signalLookup.destroy();
    this.cellSettings.destroy();
    this.factSettings.destroy();
    this.pipelines.clear();
  }
}
