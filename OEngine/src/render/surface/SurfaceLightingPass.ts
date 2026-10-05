import type { FrameGraph } from "../../framegraph/FrameGraph.js";
import type { ResourceId } from "../../framegraph/ResourceHandle.js";
import type { ShadeGPUCommandContext } from "../../framegraph/ShadeGPUCommandContext.js";
import { SurfaceFrameResources, type SurfaceResourceBinding } from "./SurfaceFrameResources.js";
import { surfaceLightingWgsl, type SurfaceLightingInput } from "./SurfaceLightingWorkPass.js";
import type { SurfaceDemandProducts } from "./SurfaceDemandPass.js";
import { LIGHT_DATABASE_DEFINITION } from "../../gpu/LightDatabase.js";
import { GPU_DATABASE_WORD_BYTES } from "../../gpu/GPUDatabase.js";
import { LIGHT_LIST_HEADER_BYTES } from "../ClusteredLightingReference.js";
import {
  LIGHT_CLUSTER_DATA_HEADER_BYTES,
  LIGHT_CLUSTER_METADATA_BYTES,
} from "../../shaders/light_cluster.js";
import type { ResourceAccounting, ResourceHandle } from "../../debug/profiling/ResourceAccounting.js";
export class SurfaceLightingPass {
  private readonly pipelines = new Map<string, GPUComputePipeline>();
  private readonly layouts: readonly GPUBindGroupLayout[];
  private readonly parameters: GPUBuffer;
  private readonly pages: GPUBuffer;
  private readonly depth: GPUTexture;
  private readonly transmittance: GPUTexture;
  private readonly sampler: GPUSampler;
  private readonly depthView: GPUTextureView;
  private readonly transmittanceView: GPUTextureView;
  private unlitBindings: {
    lights: GPUBuffer;
    parameters: GPUBuffer;
    lookup: GPUBuffer;
    data: GPUBuffer;
    list: GPUBuffer;
    environment: GPUTextureView;
    texture: GPUTexture;
    handles: ResourceHandle[];
  } | null = null;
  constructor(
    private readonly device: GPUDevice,
    private readonly scratch: SurfaceFrameResources,
    private readonly accounting?: ResourceAccounting,
  ) {
    const visibility = GPUShaderStage.COMPUTE;
    const buffer = (binding: number, type: GPUBufferBindingType): GPUBindGroupLayoutEntry => ({
      binding,
      visibility,
      buffer: { type },
    });
    const texture = (
      binding: number,
      sampleType: GPUTextureSampleType = "float",
    ): GPUBindGroupLayoutEntry => ({ binding, visibility, texture: { sampleType } });
    this.layouts = [
      device.createBindGroupLayout({
        entries: [
          buffer(0, "uniform"),
          buffer(1, "read-only-storage"),
          buffer(2, "read-only-storage"),
          buffer(3, "read-only-storage"),
          buffer(4, "storage"),
          buffer(5, "storage"),
          buffer(6, "read-only-storage"),
          buffer(7, "storage"),
          texture(13),
          texture(14),
          texture(15),
          buffer(16, "uniform"),
          texture(17),
          { binding: 18, visibility, sampler: { type: "filtering" } },
        ],
      }),
      device.createBindGroupLayout({
        entries: [
          buffer(0, "read-only-storage"),
          buffer(2, "uniform"),
          buffer(3, "read-only-storage"),
          buffer(4, "read-only-storage"),
          buffer(7, "read-only-storage"),
        ],
      }),
      device.createBindGroupLayout({ entries: [buffer(0, "uniform"), buffer(1, "uniform")] }),
      device.createBindGroupLayout({
        entries: [buffer(0, "uniform"), buffer(1, "read-only-storage"), texture(2, "depth")],
      }),
    ];
    this.parameters = device.createBuffer({
      label: "Surface/disabled lighting parameters",
      size: 256,
      usage: GPUBufferUsage.UNIFORM,
    });
    this.pages = device.createBuffer({
      label: "Surface/disabled shadow pages",
      size: 32,
      usage: GPUBufferUsage.STORAGE,
    });
    this.depth = device.createTexture({
      label: "Surface/disabled shadow atlas",
      size: [1, 1],
      format: "depth32float",
      usage: GPUTextureUsage.TEXTURE_BINDING,
    });
    this.transmittance = device.createTexture({
      label: "Surface/disabled solar transport",
      size: [1, 1],
      format: "rgba16float",
      usage: GPUTextureUsage.TEXTURE_BINDING,
    });
    this.depthView = this.depth.createView();
    this.transmittanceView = this.transmittance.createView();
    this.sampler = device.createSampler({ minFilter: "linear", magFilter: "linear" });
  }
  importUnlitProviders(
    graph: FrameGraph,
    bind: SurfaceResourceBinding,
  ): Pick<SurfaceLightingInput, "lightRecords" | "clusters" | "environment"> {
    if (this.unlitBindings === null) {
      const handles: ResourceHandle[] = [];
      const account = (kind: "buffer" | "texture", bytes: number, label: string): void => {
        const handle = this.accounting?.created({
          kind,
          bytes,
          label,
          category: "resident",
          owner: "Surface/unlit bindings",
        });
        if (handle !== undefined) {
          handles.push(handle);
        }
      };
      const lookupWords = LIGHT_DATABASE_DEFINITION.descriptors.reduce(
        (sum, table) => sum + table.page_limit,
        0,
      );
      const lights = this.device.createBuffer({
        label: "Surface/unlit empty light database",
        size: lookupWords * GPU_DATABASE_WORD_BYTES,
        usage: GPUBufferUsage.STORAGE,
        mappedAtCreation: true,
      });
      account("buffer", lights.size, lights.label);
      new Uint32Array(lights.getMappedRange()).fill(0xffffffff);
      lights.unmap();
      const buffer = (name: string, size: number, usage: number): GPUBuffer => {
        const resource = this.device.createBuffer({ label: `Surface/unlit ${name}`, size, usage });
        account("buffer", size, resource.label);
        return resource;
      };
      const texture = this.device.createTexture({
        label: "Surface/unlit unused environment",
        size: [1, 1],
        format: "rgba16float",
        usage: GPUTextureUsage.TEXTURE_BINDING,
      });
      account("texture", 8, texture.label);
      // Runtime arrays require one element in their minimum legal binding.
      // Unlit demand is zero, so no lookup or texture sample executes.
      this.unlitBindings = {
        lights,
        parameters: buffer("cluster parameters", 16, GPUBufferUsage.UNIFORM),
        lookup: buffer("cluster lookup", LIGHT_CLUSTER_METADATA_BYTES, GPUBufferUsage.STORAGE),
        data: buffer("cluster data", LIGHT_CLUSTER_DATA_HEADER_BYTES + 4, GPUBufferUsage.STORAGE),
        list: buffer("active light list", LIGHT_LIST_HEADER_BYTES + 4, GPUBufferUsage.STORAGE),
        texture,
        environment: texture.createView(),
        handles,
      };
    }
    const providers = this.unlitBindings;
    const imported = <T extends object>(name: string, resolve: () => T) =>
      graph.import_resource(
        `Surface/unlit ${name}`,
        { kind: "imported" },
        bind(`surface-unlit/${name}`, resolve),
      );
    const environment = imported("unused environment", () => providers.environment);
    return {
      lightRecords: imported("empty light database", () => providers.lights),
      clusters: {
        parameters: imported("cluster parameters", () => providers.parameters),
        lookup: imported("cluster lookup", () => providers.lookup),
        data: imported("cluster data", () => providers.data),
        activeLightList: imported("active light list", () => providers.list),
      },
      environment: { diffuse: environment, specular: environment, dfg: environment },
    };
  }
  addToGraph(
    graph: FrameGraph,
    input: SurfaceLightingInput,
  ): {
    values: ResourceId;
    demand: SurfaceDemandProducts;
  } {
    const { targets, programs, signalCapacity } = input.demand.layout;
    const key = `${targets}:${programs}`;
    let pipeline = this.pipelines.get(key);
    if (pipeline === undefined) {
      pipeline = this.device.createComputePipeline({
        label: "Surface/unique dirty Lighting",
        layout: this.device.createPipelineLayout({ bindGroupLayouts: this.layouts }),
        compute: {
          module: this.device.createShaderModule({ code: surfaceLightingWgsl(targets, programs) }),
          entryPoint: "build",
        },
      });
      this.pipelines.set(key, pipeline);
    }
    const imported = <T extends object>(name: string, resolve: () => T): ResourceId =>
      graph.import_resource(name, { kind: "imported" }, input.resourceBinding(name, resolve));
    const parameters = imported("surface-lighting-disabled-parameters", () => this.parameters);
    const pages = imported("surface-lighting-disabled-pages", () => this.pages);
    const depth = imported("surface-lighting-disabled-depth", () => this.depthView);
    const transport = imported("surface-lighting-disabled-transport", () => this.transmittanceView);
    const settingsId = this.scratch.importBuffer(
      graph,
      input.resourceBinding,
      "Surface/Lighting settings",
      32,
      GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    );
    const viewId = this.scratch.importBuffer(
      graph,
      input.resourceBinding,
      "Surface/Lighting view",
      16,
      GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    );
    let values = this.scratch.importBuffer(
      graph,
      input.resourceBinding,
      "Surface/unique signal values",
      signalCapacity * 16,
      GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    );
    const node = graph.add("Surface/unique dirty Lighting", { input, values }, (data, resources, context) => {
      const command = context.encoder as ShadeGPUCommandContext;
      const settings = resources.get(settingsId) as GPUBuffer;
      const view = resources.get(viewId) as GPUBuffer;
      command.writeBuffer(
        settings,
        0,
        new Uint32Array([
          input.width,
          input.height,
          input.constantFieldsOffset,
          input.shadow === null ? 0 : 1,
          input.physicalSun === null ? 0 : 1,
          input.diagnosticsEnabled ? 1 : 0,
          0,
          0,
        ]).buffer,
        0,
        32,
      );
      command.writeBuffer(
        view,
        0,
        new Uint32Array([input.width, input.height, input.frame, 0]).buffer,
        0,
        16,
      );
      const b = (binding: number, id: ResourceId): GPUBindGroupEntry => ({
        binding,
        resource: { buffer: resources.get(id) as GPUBuffer },
      });
      const t = (binding: number, id: ResourceId): GPUBindGroupEntry => ({
        binding,
        resource: this.scratch.resolveTextureView(resources.get(id)),
      });
      const groups = [
        this.scratch.obtainBindGroup(pipeline!, 0, [
          { binding: 0, resource: { buffer: settings } },
          b(1, input.geometry),
          b(2, input.fields),
          b(3, input.demand.fieldStore),
          b(4, input.demand.arena),
          b(5, input.demand.workspace),
          b(6, input.appearanceMetadata),
          b(7, data.values),
          t(13, input.environment.diffuse),
          t(14, input.environment.specular),
          t(15, input.environment.dfg),
          b(16, input.physicalSun?.parameters ?? parameters),
          t(17, input.physicalSun?.transmittance ?? transport),
          { binding: 18, resource: this.sampler },
        ]),
        this.scratch.obtainBindGroup(pipeline!, 1, [
          b(0, input.lightRecords),
          b(2, input.clusters.parameters),
          b(3, input.clusters.lookup),
          b(4, input.clusters.data),
          b(7, input.clusters.activeLightList),
        ]),
        this.scratch.obtainBindGroup(pipeline!, 2, [
          { binding: 0, resource: { buffer: view } },
          b(1, input.camera),
        ]),
        this.scratch.obtainBindGroup(pipeline!, 3, [
          b(0, input.shadow?.lightProjection ?? parameters),
          b(1, input.shadow?.virtualPageTable ?? pages),
          t(2, input.shadow?.physicalAtlasDepth ?? depth),
        ]),
      ];
      const pass = command.beginComputePass({ label: "Surface/unique dirty Lighting" });
      pass.setPipeline(pipeline!);
      groups.forEach((group, index) => pass.setBindGroup(index, group));
      pass.dispatchWorkgroupsIndirect(resources.get(input.demand.indirect) as GPUBuffer, 128);
      pass.end();
    });
    const reads = [
      input.geometry,
      input.fields,
      input.demand.fieldStore,
      input.demand.arena,
      input.demand.workspace,
      input.appearanceMetadata,
      input.camera,
      input.environment.diffuse,
      input.environment.specular,
      input.environment.dfg,
      input.lightRecords,
      input.clusters.parameters,
      input.clusters.lookup,
      input.clusters.data,
      input.clusters.activeLightList,
      input.physicalSun?.parameters ?? parameters,
      input.physicalSun?.transmittance ?? transport,
      input.shadow?.lightProjection ?? parameters,
      input.shadow?.virtualPageTable ?? pages,
      input.shadow?.physicalAtlasDepth ?? depth,
    ];
    for (const resource of reads) {
      node.read(resource);
    }
    values = node.write(values);
    node.write(settingsId);
    node.write(viewId);
    node.read(input.demand.indirect);
    const arena = node.write(input.demand.arena);
    return { values, demand: { ...input.demand, arena } };
  }
  destroy(): void {
    if (this.unlitBindings !== null) {
      const disabled = this.unlitBindings;
      for (const buffer of [
        disabled.lights,
        disabled.parameters,
        disabled.lookup,
        disabled.data,
        disabled.list,
      ]) {
        buffer.destroy();
      }
      disabled.texture.destroy();
      for (const handle of disabled.handles) {
        this.accounting!.destroyed(handle);
      }
      this.unlitBindings = null;
    }
    this.parameters.destroy();
    this.pages.destroy();
    this.depth.destroy();
    this.transmittance.destroy();
    this.pipelines.clear();
  }
}
