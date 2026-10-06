import type { FrameGraph } from "../../framegraph/FrameGraph.js";
import type { ResourceId } from "../../framegraph/ResourceHandle.js";
import type { ShadeGPUCommandContext } from "../../framegraph/ShadeGPUCommandContext.js";
import { SurfaceFrameResources, type SurfaceResourceBinding } from "./SurfaceFrameResources.js";
import { LIGHT_DATABASE_DEFINITION } from "../../gpu/LightDatabase.js";
import { GPU_DATABASE_WORD_BYTES } from "../../gpu/GPUDatabase.js";
import { LIGHT_LIST_HEADER_BYTES } from "../ClusteredLightingReference.js";
import {
  LIGHT_CLUSTER_DATA_HEADER_BYTES,
  LIGHT_CLUSTER_METADATA_BYTES
} from "../../shaders/light_cluster.js";
import type { ResourceAccounting, ResourceHandle } from "../../debug/profiling/ResourceAccounting.js";
export interface SurfaceLightingProviders {
  readonly lightRecords: ResourceId;
  readonly clusters: {
    readonly parameters: ResourceId;
    readonly lookup: ResourceId;
    readonly data: ResourceId;
    readonly activeLightList: ResourceId;
  };
  readonly environment: {
    readonly diffuse: ResourceId;
    readonly specular: ResourceId;
    readonly dfg: ResourceId;
  };
}
export class SurfaceLightingBindings {
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
    private readonly accounting?: ResourceAccounting
  ) {}
  importUnlitProviders(graph: FrameGraph, bind: SurfaceResourceBinding): SurfaceLightingProviders {
    if (this.unlitBindings === null) {
      const handles: ResourceHandle[] = [];
      const account = (kind: "buffer" | "texture", bytes: number, label: string): void => {
        const handle = this.accounting?.created({
          kind,
          bytes,
          label,
          category: "resident",
          owner: "Surface/unlit bindings"
        });
        if (handle !== undefined) {
          handles.push(handle);
        }
      };
      const lookupWords = LIGHT_DATABASE_DEFINITION.descriptors.reduce(
        (sum, table) => sum + table.page_limit,
        0
      );
      const lights = this.device.createBuffer({
        label: "Surface/unlit empty light database",
        size: lookupWords * GPU_DATABASE_WORD_BYTES,
        usage: GPUBufferUsage.STORAGE,
        mappedAtCreation: true
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
        usage: GPUTextureUsage.TEXTURE_BINDING
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
        handles
      };
    }
    const providers = this.unlitBindings;
    const imported = <T extends object>(name: string, resolve: () => T) =>
      graph.import_resource(
        `Surface/unlit ${name}`,
        { kind: "imported" },
        bind(`surface-unlit/${name}`, resolve)
      );
    const environment = imported("unused environment", () => providers.environment);
    return {
      lightRecords: imported("empty light database", () => providers.lights),
      clusters: {
        parameters: imported("cluster parameters", () => providers.parameters),
        lookup: imported("cluster lookup", () => providers.lookup),
        data: imported("cluster data", () => providers.data),
        activeLightList: imported("active light list", () => providers.list)
      },
      environment: { diffuse: environment, specular: environment, dfg: environment }
    };
  }
  destroy(): void {
    if (this.unlitBindings !== null) {
      const disabled = this.unlitBindings;
      for (const buffer of [
        disabled.lights,
        disabled.parameters,
        disabled.lookup,
        disabled.data,
        disabled.list
      ]) {
        buffer.destroy();
      }
      disabled.texture.destroy();
      for (const handle of disabled.handles) {
        this.accounting!.destroyed(handle);
      }
      this.unlitBindings = null;
    }
  }
}
