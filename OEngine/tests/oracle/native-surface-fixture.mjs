import { FrameGeometryArena } from "../../.test-dist/render/FrameGeometryArena.js";
import { FrameGeometryVertices } from "../../.test-dist/render/FrameGeometryVertices.js";
import {
  GPU_GEOMETRY_RECORD_SCHEMA,
  GPU_MESHLET_RECORD_SCHEMA
} from "../../.test-dist/gpu/GpuGeometryAbi.js";
import {
  GPU_FRAME_INSTANCE_STRIDE,
  GPU_FRAME_INSTANCE_OFFSETS
} from "../../.test-dist/gpu/GpuFrameInstanceAbi.js";
import { GPU_INSTANCE_RECORD_STRIDE, packGpuInstanceRecord } from "../../.test-dist/gpu/GpuInstanceAbi.js";
import {
  GPU_MESHLET_WORK_QUEUE_HEADER_STRIDE,
  GPU_MESHLET_RASTER_WORK_RECORD_STRIDE,
  packGpuMeshletWorkQueueHeader,
  packGpuMeshletRasterWork
} from "../../.test-dist/gpu/GpuMeshletRasterWorkAbi.js";
import {
  POINT_LIGHT_DESCRIPTOR,
  POINT_LIGHT_RECORD_TYPE,
  DIRECTIONAL_LIGHT_DESCRIPTOR,
  DIRECTIONAL_LIGHT_RECORD_TYPE
} from "../../.test-dist/gpu/LightDatabase.js";
import { lightSphereDistanceAttenuation } from "../../.test-dist/render/DirectLightingReference.js";
import { decodeFloat16, encodeFloat16 } from "../../.test-dist/core/Float16.js";

const CELL = 8;
const GENERATION = 11;
export const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const pointLights = Array.from({ length: 8 }, (_, i) => ({
  position: [Math.cos((i * Math.PI) / 4) * 1.5, Math.sin((i * Math.PI) / 4) * 1.5, 2.5],
  color: [1.1 + i * 0.1, 0.7 + i * 0.08, 0.4 + i * 0.06],
  distance: 8,
  radius: 0.1
}));
/** Test scene, not a second renderer. Real arena/vertex producer and GPU ABI;
 * authored cluster lists/VSM page residency are provider fixtures, not measured
 * producer costs. Geometry is a tessellated quad; no scene LOD/streaming claim. */
export async function createNativeSurfaceFixture(
  device,
  {
    width = 128,
    height = 64,
    materialCount = 8,
    scale = [1, 1, 1],
    instanceCount = 8,
    perspective = 0,
    highCoverage = false
  } = {}
) {
  const WIDTH = width,
    HEIGHT = height;
  const retained = [];
  const makeBuffer = (dataOrSize, usage, label) => {
    const buffer = device.createBuffer({
      size: typeof dataOrSize === "number" ? dataOrSize : dataOrSize.byteLength,
      usage,
      label
    });
    if (typeof dataOrSize !== "number") device.queue.writeBuffer(buffer, 0, dataOrSize);
    retained.push(buffer);
    return buffer;
  };
  const storage = (data, label) =>
    makeBuffer(data, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC, label);
  const uniform = (data, label) => makeBuffer(data, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST, label);
  const makeTexture = (width, height, format, usage, layers = 1, mipLevelCount = 1) => {
    const texture = device.createTexture({ size: [width, height, layers], format, usage, mipLevelCount });
    retained.push(texture);
    return texture;
  };
  const uploadedTextureUsage = GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST;
  const arenaOwner = new FrameGeometryArena(device);
  const verticesOwner = new FrameGeometryVertices(device);
  try {
    const workCount = ((WIDTH / CELL) * HEIGHT) / CELL;
    const transform = [...identity];
    transform[0] = scale[0];
    transform[5] = scale[1];
    transform[10] = scale[2];
    const determinant = scale[0] * scale[1] * scale[2];
    const instance = new Uint8Array(GPU_FRAME_INSTANCE_STRIDE);
    instance.set(
      packGpuInstanceRecord({
        geometryRecordIndex: 1,
        geometryGeneration: 3,
        instanceSetGeneration: 7,
        materialHandle: 0,
        flags: 1,
        debugId: 0,
        boundsSphere: [0, 0, 0, 2],
        boundsMin: [-1, -1, 0, 0],
        boundsMax: [1, 1, 1, 0],
        currentObjectToWorld: transform,
        previousObjectToWorld: identity,
        dynamicRevision: 1
      })
    );
    const instanceFloats = new Float32Array(instance.buffer);
    const clip = [...transform];
    clip[3] = perspective * scale[0];
    instanceFloats.set(clip, GPU_FRAME_INSTANCE_OFFSETS.objectToClip / 4);
    instanceFloats.set(
      [scale[1] * scale[2], 0, 0, determinant, 0, scale[0] * scale[2], 0, 0, 0, 0, scale[0] * scale[1], 0],
      GPU_FRAME_INSTANCE_OFFSETS.normalX / 4
    );
    new DataView(instance.buffer).setUint32(GPU_FRAME_INSTANCE_OFFSETS.generation, GENERATION, true);
    const instanceRecords = new Uint8Array(instanceCount * GPU_FRAME_INSTANCE_STRIDE);
    for (let i = 0; i < instanceCount; i++) instanceRecords.set(instance, i * GPU_FRAME_INSTANCE_STRIDE);
    const instances = storage(instanceRecords, "S1/frame instance ABI");
    const sceneRecords = new Uint8Array(instanceCount * GPU_INSTANCE_RECORD_STRIDE);
    for (let i = 0; i < instanceCount; i++)
      sceneRecords.set(instance.subarray(0, GPU_INSTANCE_RECORD_STRIDE), i * GPU_INSTANCE_RECORD_STRIDE);
    const sceneInstances = storage(sceneRecords, "S1/authoritative scene instance ABI");
    const geometryWords = GPU_GEOMETRY_RECORD_SCHEMA.stride / 4;
    const meshletWords = GPU_MESHLET_RECORD_SCHEMA.stride / 4;
    const metadata = new Uint32Array(geometryWords + workCount * meshletWords);
    const indexWords = workCount * 4;
    const triangleWordBase = indexWords;
    const attributeWordBase = triangleWordBase + workCount * 2;
    const payload = new Uint32Array(attributeWordBase + workCount * 4 * 24);
    const payloadFloats = new Float32Array(payload.buffer);
    metadata[GPU_GEOMETRY_RECORD_SCHEMA.offsets.resident_attribute_word_offset / 4] = attributeWordBase;
    const workBytes = new Uint8Array(
      GPU_MESHLET_WORK_QUEUE_HEADER_STRIDE + workCount * GPU_MESHLET_RASTER_WORK_RECORD_STRIDE
    );
    workBytes.set(
      packGpuMeshletWorkQueueHeader({
        attemptedCount: workCount,
        writtenCount: workCount,
        consumedCount: 0,
        capacity: workCount,
        overflowCount: 0,
        generation: GENERATION,
        invalidCount: 0
      })
    );
    for (let slot = 0; slot < workCount; slot++) {
      const tileX = slot % (WIDTH / CELL),
        tileY = Math.floor(slot / (WIDTH / CELL));
      const at = geometryWords + slot * meshletWords;
      for (const [name, value] of Object.entries({
        vertex_offset: slot * 4,
        vertex_count: 4,
        triangle_byte_offset: slot * 8,
        triangle_count: 2
      })) {
        metadata[at + GPU_MESHLET_RECORD_SCHEMA.offsets[name] / 4] = value;
      }
      payload.set([slot * 4, slot * 4 + 1, slot * 4 + 2, slot * 4 + 3], slot * 4);
      new Uint8Array(payload.buffer).set([0, 2, 1, 2, 3, 1, 0, 0], (triangleWordBase + slot * 2) * 4);
      for (let corner = 0; corner < 4; corner++) {
        const x = (((tileX + (corner & 1)) * CELL) / WIDTH) * 2 - 1;
        const y = 1 - (((tileY + (corner >> 1)) * CELL) / HEIGHT) * 2;
        payloadFloats.set(
          [0, 0, 1, 1, 1, 0, 0, 1, (x + 1) * 0.5, (y + 1) * 0.5, 0, 0, 1, 1, 1, 1, 0, 0, 0, 0, x, y, 0.5, 1],
          attributeWordBase + (slot * 4 + corner) * 24
        );
      }
      workBytes.set(
        packGpuMeshletRasterWork({
          instanceSlot: slot % instanceCount,
          geometrySlot: 0,
          meshletSlot: slot,
          materialSlotOrRange: highCoverage
            ? [0, 0, 0, 1, 2, 3, 4, 4, 4, 5, 6, 7, 0, 4, 0, 4, 0, 4, 0, 4][slot % 20]
            : slot % materialCount,
          packedRasterFlags: 0,
          packedProfileLod: 0
        }),
        GPU_MESHLET_WORK_QUEUE_HEADER_STRIDE + slot * GPU_MESHLET_RASTER_WORK_RECORD_STRIDE
      );
    }
    const sourceMetadata = storage(metadata, "S1/asset metadata ABI");
    const vertexPayload = storage(payload, "S1/resident vertex payload ABI");
    const work = storage(workBytes, "S1/meshlet queue ABI");
    const arena = arenaOwner.prepare(sourceMetadata, sourceMetadata.size, {
      workCapacity: workCount,
      vertexCapacity: workCount * 4,
      triangleCapacity: workCount * 2,
      maxBytes: 128 * 1024 * 1024
    });
    await verticesOwner.ready;
    const prepared = verticesOwner.prepare({
      arena,
      instances: { records: instances },
      work,
      assets: {
        sparseShading: {
          assetMetadataHeap: sourceMetadata,
          vertexPayloadHeap: vertexPayload,
          geometryWordBase: 0,
          meshletWordBase: geometryWords,
          meshletVertexWordBase: 0,
          meshletTriangleWordBase: triangleWordBase,
          vertexDataWordBase: 0
        }
      }
    });
    const geometryEncoder = device.createCommandEncoder();
    const commitMetadata = arenaOwner.encodeMetadataPublication(geometryEncoder, arena);
    verticesOwner.encode(geometryEncoder, prepared);
    device.queue.submit([geometryEncoder.finish()]);
    commitMetadata();
    await device.queue.onSubmittedWorkDone();

    const environment = (color, mipLevels) => {
      const texture = makeTexture(256, 256, "rgba16float", uploadedTextureUsage, 1, mipLevels);
      for (let mip = 0; mip < mipLevels; mip++) {
        const size = 256 >> mip;
        const values = new Uint16Array(size * size * 4);
        for (let i = 0; i < values.length; i += 4) {
          values.set([...color, 1].map(encodeFloat16), i);
        }
        device.queue.writeTexture({ texture, mipLevel: mip }, values, { bytesPerRow: size * 8 }, [
          size,
          size
        ]);
      }
      return texture;
    };
    const diffuseEnvironment = environment([0.2, 0.25, 0.3], 1);
    const specularEnvironment = environment([0.25, 0.3, 0.35], 9);
    const dfg = environment([0.5, 0.2, 0], 1);
    const lightWords = new Uint32Array(32768).fill(0xffffffff);
    const lightFloats = new Float32Array(lightWords.buffer);
    const writeLightPage = (descriptor, type, page, records) => {
      lightWords[descriptor.page_lookup_address] = page;
      lightWords.fill(0, page, page + descriptor.page_header_words);
      lightWords[page + 1] = (1 << records.length) - 1;
      records.forEach((record, i) => {
        const base = page + descriptor.page_header_words + (i * type.size) / 4;
        for (const field of type.fields) {
          const at = base + field.offset / 4;
          const value = record[field.name] ?? 0;
          if (field.name === "flags" || field.name === "shadow_id") {
            lightWords[at] = value;
          } else if (Array.isArray(value)) {
            lightFloats.set(value, at);
          } else {
            lightFloats[at] = value;
          }
        }
      });
    };
    writeLightPage(POINT_LIGHT_DESCRIPTOR, POINT_LIGHT_RECORD_TYPE, 8000, pointLights);
    writeLightPage(DIRECTIONAL_LIGHT_DESCRIPTOR, DIRECTIONAL_LIGHT_RECORD_TYPE, 12000, [
      { direction: [0, 0, -1], color: [0.8, 0.6, 0.4], flags: 1 }
    ]);
    const lights = storage(lightWords, "S1/real light database ABI");
    // Complete DIRECT fixture uses the same frame-local ABI as production.
    const packedLocal = new ArrayBuffer(128);
    new Uint32Array(packedLocal).set([
      WIDTH,
      HEIGHT,
      Math.ceil(WIDTH / 32),
      Math.ceil(HEIGHT / 32),
      1,
      0,
      1,
      8
    ]);
    const localFloats = new Float32Array(packedLocal);
    localFloats.set([0.1, 100, 0, 0.1, 1, 1, 0, 0], 8);
    localFloats.set(identity, 16);
    const localParameters = uniform(new Uint32Array(packedLocal), "native/local parameters");
    const localLookup = storage(8, "native/local lookup");
    const localData = storage(160, "native/local complete IDs");
    const setLightCount = (count, frameIndex = 0) => {
      const header = new Uint32Array(40);
      header.set([1, count ? 1 : 0, 0, 1, frameIndex, 1, count, 0, 0, count, 0, 0, count * 2]);
      header.set([0, 1, 2, 3, 4, 5, 6, 7], 32);
      device.queue.writeBuffer(localData, 0, header);
      device.queue.writeBuffer(localParameters, 20, new Uint32Array([frameIndex, 1, count]));
    };
    const pages = new Uint32Array((16 * 16 + 8 * 8 + 4 * 4 + 2 * 2 + 1 + 1) * 8);
    for (let y = 0; y < 16; y++) {
      for (let x = 0; x < 16; x++) {
        pages.set([x, y, 0, 9, GENERATION, 0, 0, 0], (x + y * 16) * 8);
      }
    }
    const pageTable = storage(pages, "S1/resident VSM page ABI");
    const vsmValues = new Float32Array(60);
    vsmValues.set(identity);
    vsmValues.set([-1, -1, 2, 0], 16);
    new Uint32Array(vsmValues.buffer).set([16, 128, 2, 16, 1, GENERATION, 2, 2112], 40);
    const vsmConstants = uniform(vsmValues, "S1/VSM constants");
    const atlas = makeTexture(
      2112,
      2112,
      "depth32float",
      GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING
    );
    const atlasModule = device.createShaderModule({
      code: `
@vertex fn vs(@builtin(vertex_index) i:u32)->@builtin(position) vec4f {
  let x=f32((i << 1u) & 2u); let y=f32(i & 2u);
  return vec4f(x*2.0-1.0,y*2.0-1.0,0.5,1.0);
}
@fragment fn fs(@builtin(position) p:vec4f)->@builtin(frag_depth) f32 {
  return select(0.0,0.8,((u32(p.x)/132u+u32(p.y)/132u)&1u)!=0u);
}`
    });
    const atlasPipeline = await device.createRenderPipelineAsync({
      layout: "auto",
      vertex: { module: atlasModule, entryPoint: "vs" },
      fragment: { module: atlasModule, entryPoint: "fs", targets: [] },
      primitive: { topology: "triangle-list" },
      depthStencil: { format: "depth32float", depthWriteEnabled: true, depthCompare: "always" }
    });
    const atlasEncoder = device.createCommandEncoder();
    const atlasPass = atlasEncoder.beginRenderPass({
      colorAttachments: [],
      depthStencilAttachment: {
        view: atlas.createView(),
        depthClearValue: 0,
        depthLoadOp: "clear",
        depthStoreOp: "store"
      }
    });
    atlasPass.setPipeline(atlasPipeline);
    atlasPass.draw(3);
    atlasPass.end();
    device.queue.submit([atlasEncoder.finish()]);
    await device.queue.onSubmittedWorkDone();

    setLightCount(8);
    const visibility = makeTexture(
      WIDTH,
      HEIGHT,
      "r32uint",
      GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC
    );
    const depth = makeTexture(
      WIDTH,
      HEIGHT,
      "depth32float",
      GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING
    );
    const background = makeTexture(
      WIDTH,
      HEIGHT,
      "rgba16float",
      uploadedTextureUsage | GPUTextureUsage.STORAGE_BINDING
    );
    const backgroundValues = new Uint16Array(WIDTH * HEIGHT * 4);
    for (let p = 0; p < WIDTH * HEIGHT; p++)
      backgroundValues.set([0.02, 0.04, 0.08, 1].map(encodeFloat16), p * 4);
    device.queue.writeTexture({ texture: background }, backgroundValues, { bytesPerRow: WIDTH * 8 }, [
      WIDTH,
      HEIGHT
    ]);
    const ao = makeTexture(WIDTH, HEIGHT, "r8unorm", uploadedTextureUsage);
    device.queue.writeTexture(
      { texture: ao },
      new Uint8Array(WIDTH * HEIGHT).fill(192),
      { bytesPerRow: WIDTH },
      [WIDTH, HEIGHT]
    );
    const view = uniform(new Uint32Array([WIDTH, HEIGHT, 0, 0]), "S1/light view");
    const exposure = storage(new Float32Array([1.25, 0, 0, 0]), "S1/GPU exposure");
    const lightingEntries = [
      { binding: 0, resource: { buffer: lights } },
      { binding: 1, resource: { buffer: localParameters } },
      { binding: 2, resource: { buffer: localLookup } },
      { binding: 3, resource: { buffer: localData } },
      { binding: 4, resource: { buffer: view } },
      { binding: 5, resource: diffuseEnvironment.createView() },
      { binding: 6, resource: specularEnvironment.createView() },
      { binding: 7, resource: dfg.createView() },
      { binding: 8, resource: { buffer: vsmConstants } },
      { binding: 9, resource: { buffer: pageTable } },
      { binding: 10, resource: atlas.createView() },
      { binding: 11, resource: ao.createView() }
    ];
    const projection = [...identity];
    projection[3] = perspective;
    return {
      scale,
      perspective,
      projection,
      instanceCount,
      sceneInstances,
      width: WIDTH,
      height: HEIGHT,
      generation: GENERATION,
      workCount,
      visibility,
      depth,
      background,
      exposure,
      lightingEntries,
      geometry: {
        meshletWork: work,
        arena: arena.buffer,
        vertexPayload,
        instances,
        source: [0, geometryWords, 0, triangleWordBase],
        sourcePayload: [0, 0, 0, arena.layout.header.offset / 4]
      },
      sparseShading: {
        assetMetadataHeap: sourceMetadata,
        vertexPayloadHeap: vertexPayload,
        geometryWordBase: 0,
        meshletWordBase: geometryWords,
        meshletVertexWordBase: 0,
        meshletTriangleWordBase: triangleWordBase,
        vertexDataWordBase: 0
      },
      storage,
      uniform,
      makeTexture,
      setLightCount,
      destroy() {
        verticesOwner.destroy();
        arenaOwner.destroy();
        for (const resource of retained) resource.destroy();
      }
    };
  } catch (error) {
    verticesOwner.destroy();
    arenaOwner.destroy();
    for (const resource of retained) resource.destroy();
    throw error;
  }
}
