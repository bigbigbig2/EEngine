import type { GpuAssetBindings } from "../gpu/GpuAssetStore.js";
import type { GpuSceneBindings } from "../gpu/GpuScene.js";
import type { GraphicsContext } from "../gpu/GraphicsContext.js";
import type { GpuRenderWorldRuntime } from "../gpu/GpuRenderWorld.js";
import { gpuVisibilityKeyRenderPassAttachments } from "../gpu/GpuVisibilityKeyAbi.js";
import { nativeVisibilityView } from "../shaders/native_visibility.js";
import type { PreparedMeshletWorkCandidate } from "./MeshletWorkCandidate.js";
import type { PreparedFrameVertices } from "./FrameGeometryVertices.js";
import { NativeVisibilityPass } from "./surface/NativeVisibilityPass.js";
import type { NativeSurfaceGeometry } from "./surface/SurfaceV4.js";

export function nativeWinnerGeometry(
  assets: GpuAssetBindings,
  vertices: PreparedFrameVertices,
  work: GPUBuffer,
  instances: GPUBuffer,
  runtime: GpuRenderWorldRuntime,
): NativeSurfaceGeometry {
  const source = assets.sparseShading;
  const product = runtime.virtualGeometry;
  return {
    meshletWork: work,
    arena: vertices.arena.buffer,
    vertexPayload: source.vertexPayloadHeap,
    instances,
    source: [
      source.geometryWordBase,
      source.meshletWordBase,
      source.meshletVertexWordBase,
      source.meshletTriangleWordBase,
    ],
    sourcePayload: [source.vertexDataWordBase, 0, 0, vertices.arena.layout.header.offset / 4],
    ...(product
      ? {
          productHeap: product.metadata,
          productBanks: product.banks.slice(0, 4) as [GPUBuffer, GPUBuffer, GPUBuffer, GPUBuffer],
        }
      : {}),
  };
}

export interface MeshletBucketRasterInputs {
  readonly prepared: PreparedMeshletWorkCandidate;
  readonly camera: GPUBuffer;
  readonly assets: GpuAssetBindings;
  readonly scene: GpuSceneBindings;
  readonly frameInstances: GPUBuffer;
  readonly frameVertices: PreparedFrameVertices;
  readonly runtime: GpuRenderWorldRuntime;
  readonly visibilityKey: GPUTextureView;
  readonly depth: GPUTextureView;
  readonly virtualGeometry?: import("../gpu/VirtualGeometryResidency.js").GeometryProductGpuBindingsV1 | null;
}

/** Native alpha and native raster work share the exact material publication.
 * Winner remains r32uint; no old coverage directory or Surface bin MRT exists. */
export class MeshletBucketRaster {
  readonly primitiveIndexSupported = false;
  private readonly passes = new Map<GPUBuffer, NativeVisibilityPass>();
  constructor(private readonly graphics: GraphicsContext) {}

  prepare(
    runtime: GpuRenderWorldRuntime,
    _prepared: PreparedMeshletWorkCandidate,
    _assets: GpuAssetBindings,
    _queue?: GPUBuffer,
  ): void {
    if (runtime.nativeMaterials === null) {
      throw new Error("Visibility requires native material publication");
    }
  }

  encodeRaster(encoder: GPUCommandEncoder, input: MeshletBucketRasterInputs): void {
    this.encode(encoder, input, input.prepared.queue, false);
  }

  encodeRecoveryRaster(encoder: GPUCommandEncoder, input: MeshletBucketRasterInputs): void {
    if (!input.prepared.productMode) {
      throw new Error("Late HZB raster requires Product geometry");
    }
    this.encode(encoder, input, input.prepared.queue, true);
  }

  private encode(
    encoder: GPUCommandEncoder,
    input: MeshletBucketRasterInputs,
    queue: GPUBuffer,
    late: boolean,
  ): void {
    const scene = input.runtime.nativeMaterials!;
    const geometry = nativeWinnerGeometry(
      input.assets,
      input.frameVertices,
      queue,
      input.frameInstances,
      input.runtime,
    );
    const view = nativeVisibilityView(input.frameVertices.arena, 1, {
      clipFromWorld: new Float32Array(16),
      viewMatrix: new Float32Array(16),
      cameraPosition: [0, 0, 0],
      filtered: false,
      source: geometry.source,
      sourcePayload: geometry.sourcePayload,
    });
    let pass = this.passes.get(queue);
    if (
      pass !== undefined &&
      (pass.input.publication !== scene.publication ||
        pass.input.camera !== input.camera ||
        pass.input.geometry.arena !== geometry.arena ||
        pass.input.geometry.instances !== geometry.instances ||
        pass.input.geometry.vertexPayload !== geometry.vertexPayload ||
        pass.input.geometry.productHeap !== geometry.productHeap)
    ) {
      void pass.retire(this.graphics.device.queue.onSubmittedWorkDone());
      this.passes.delete(queue);
      pass = undefined;
    }
    if (pass === undefined) {
      pass = new NativeVisibilityPass(this.graphics.device, {
        graphics: this.graphics,
        geometry,
        publication: scene.publication,
        capacity: input.prepared.capacity,
        generation: 1,
        generationSource: queue,
        camera: input.camera,
        view,
      });
      this.passes.set(queue, pass);
    } else {
      pass.update(view, 1);
    }
    pass.encode(
      encoder,
      {
        label: "Visibility/native material winner",
        colorAttachments: late
          ? [{ view: input.visibilityKey, loadOp: "load", storeOp: "store" }]
          : gpuVisibilityKeyRenderPassAttachments(input.visibilityKey),
        depthStencilAttachment: {
          view: input.depth,
          depthClearValue: 0,
          depthLoadOp: late ? "load" : "clear",
          depthStoreOp: "store",
        },
      },
      late,
    );
  }

  release(queue: GPUBuffer): void {
    this.passes.get(queue)?.destroy();
    this.passes.delete(queue);
  }
  destroy(): void {
    this.passes.forEach((pass) => pass.destroy());
    this.passes.clear();
  }
}
