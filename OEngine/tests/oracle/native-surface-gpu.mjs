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
import { packGpuInstanceRecord } from "../../.test-dist/gpu/GpuInstanceAbi.js";
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
import { lightSphereDistanceAttenuation } from "../../.test-dist/render/ClusteredLightingReference.js";
import { decodeFloat16, encodeFloat16 } from "../../.test-dist/core/Float16.js";
import { GPUTimer } from "../../.test-dist/framegraph/GPUTimer.js";
import { GPUFrameTimingRing } from "../../.test-dist/framegraph/GPUFrameTiming.js";
import {
  PROBE_VISIBILITY_WGSL,
  COMPACT_RECORD_BYTES,
  nativeSurfaceProbeWgsl
} from "./native-surface-shader.mjs";

const WIDTH = 1920;
const HEIGHT = 1080;
const PIXELS = WIDTH * HEIGHT;
const CELL = 8;
const GENERATION = 11;
const TEXTURE_SIZE = 512;
const MIP_COUNT = 10;
const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const pointLights = Array.from({ length: 8 }, (_, i) => ({
  position: [Math.cos((i * Math.PI) / 4) * 1.5, Math.sin((i * Math.PI) / 4) * 1.5, 2.5],
  color: [1.1 + i * 0.1, 0.7 + i * 0.08, 0.4 + i * 0.06],
  distance: 8,
  radius: 0.1
}));
const check = (condition, message) => {
  if (!condition) {
    throw new Error(message);
  }
};
const normalize = (v) => {
  const length = Math.hypot(...v);
  return v.map((value) => value / length);
};
const dot = (a, b) => a.reduce((sum, v, i) => sum + v * b[i], 0);
const clamp = (v) => Math.min(1, Math.max(0, v));
const workingColor = (c) => [
  c[0] * 0.627404 + c[1] * 0.329282 + c[2] * 0.0433136,
  c[0] * 0.069097 + c[1] * 0.91954 + c[2] * 0.0113612,
  c[0] * 0.0163916 + c[1] * 0.0880132 + c[2] * 0.895595
];

// Independent double-precision BRDF algebra matching the existing Lambert /
// Smith-GGX / Schlick / clearcoat profile. The old DirectLightingReference has
// a different diffuse-energy convention and is deliberately not our oracle.
function directReference(surface, position, direction, radiance) {
  const view = normalize(position.map((v, i) => [0, 0, 3][i] - v));
  const half = normalize(view.map((v, i) => v + direction[i]));
  const noL = clamp(dot(surface.normal, direction));
  const noV = clamp(dot(surface.normal, view));
  const noH = clamp(dot(surface.normal, half));
  const voH = clamp(dot(view, half));
  const alpha = Math.max(surface.roughness ** 2, 0.002);
  const a2 = alpha * alpha;
  const distribution = a2 / (Math.PI * (noH * noH * (a2 - 1) + 1) ** 2);
  const visibility =
    0.5 /
    Math.max(noL * Math.sqrt(noV * noV * (1 - a2) + a2) + noV * Math.sqrt(noL * noL * (1 - a2) + a2), 1e-6);
  const coatFresnel = (0.04 + 0.96 * (1 - voH) ** 5) * surface.coat[0];
  const coatAlpha2 = Math.max(surface.coat[1] ** 2, 0.002) ** 2;
  const coatD = coatAlpha2 / (Math.PI * (half[2] ** 2 * (coatAlpha2 - 1) + 1) ** 2);
  const coatBrdf = ((coatD * 0.25) / Math.max(voH * voH, 0.0000039)) * coatFresnel;
  return radiance.map((r, i) => {
    const f0 = 0.04 + (surface.base[i] - 0.04) * surface.metallic;
    const fresnel = f0 + (1 - f0) * (1 - voH) ** 5;
    return (
      r *
      (noL *
        (fresnel * visibility * distribution + (surface.base[i] * (1 - surface.metallic)) / Math.PI) *
        (1 - coatFresnel) +
        clamp(direction[2]) * coatBrdf)
    );
  });
}

function materialTexel(layer, x, y, size) {
  const u = x / Math.max(1, size - 1);
  const v = y / Math.max(1, size - 1);
  return [
    [60 + Math.round(u * 120), 50 + Math.round(v * 130), 140, 255],
    [210, 100 + Math.round(u * 50), 120 + Math.round(v * 40), 255],
    [140, 120, 253, 255],
    [80, 60, 30, 255],
    [180, 160, 255, 255]
  ][layer];
}

function sampleReference(layer, uv) {
  // GPU trilinear explicit-gradient LOD; independent fixture sampler.
  const lod = Math.max(0, Math.log2(Math.max((TEXTURE_SIZE * 16) / WIDTH, (TEXTURE_SIZE * 16) / HEIGHT)));
  const sampleMip = (mip) => {
    const size = TEXTURE_SIZE >> mip;
    const location = uv.map((v) => (v - Math.floor(v)) * size - 0.5);
    const base = location.map(Math.floor);
    const fraction = location.map((v, i) => v - base[i]);
    const sample = (dx, dy) =>
      materialTexel(
        layer,
        (((base[0] + dx) % size) + size) % size,
        (((base[1] + dy) % size) + size) % size,
        size
      );
    const a = sample(0, 0),
      b = sample(1, 0),
      c = sample(0, 1),
      d = sample(1, 1);
    return a.map(
      (v, i) =>
        ((v * (1 - fraction[0]) + b[i] * fraction[0]) * (1 - fraction[1]) +
          (c[i] * (1 - fraction[0]) + d[i] * fraction[0]) * fraction[1]) /
        255
    );
  };
  const lower = sampleMip(Math.floor(lod));
  const upper = sampleMip(Math.ceil(lod));
  return lower.map((v, i) => v + (upper[i] - v) * (lod % 1));
}

function expectedPixel(x, y, stage, lights) {
  const position = [((x + 0.5) / WIDTH) * 2 - 1, 1 - ((y + 0.5) / HEIGHT) * 2, 0.5];
  const uv = [(position[0] + 1) * 8, (position[1] + 1) * 8];
  const base = sampleReference(0, uv)
    .slice(0, 3)
    .map((v, i) => v * [0.8, 0.7, 0.6][i]);
  if (stage === 6) {
    return workingColor(base).map((v) => v * 1.25);
  }
  const orm = sampleReference(1, uv);
  const normal = normalize(
    sampleReference(2, uv)
      .slice(0, 3)
      .map((v) => v * 2 - 1)
  );
  const emissive = [(80 / 255) * 0.1, (60 / 255) * 0.05, (30 / 255) * 0.02];
  const surface = {
    base,
    normal,
    metallic: orm[2] * 0.7,
    roughness: Math.max(orm[1] * 0.8, 0.04),
    occlusion: 1 - 0.8 * (1 - orm[0]),
    coat: [(180 / 255) * 0.35, (160 / 255) * 0.4]
  };
  let color;
  if (stage === 0) {
    color = position.map(
      (v, i) => Math.abs(v) + [0.1, 0, 0.1][i] + [uv[0], uv[1], 16 / WIDTH - 16 / HEIGHT][i] * 0.01
    );
  } else if (stage === 1) {
    const geometry = position.map(
      (v, i) => Math.abs(v) + [0.1, 0, 0.1][i] + [uv[0], uv[1], 16 / WIDTH - 16 / HEIGHT][i] * 0.01
    );
    color = base.map(
      (v, i) =>
        geometry[i] +
        v +
        emissive[i] +
        (surface.metallic + surface.roughness + surface.occlusion + surface.coat[0] + surface.coat[1]) *
          0.01 +
        Math.abs(normal[i]) * 0.01
    );
  } else {
    // A 2x2 PCF entirely inside one checkerboard atlas page. Samples used by
    // the oracle are intentionally away from virtual page boundaries.
    const shadow =
      stage >= 4 && (Math.floor((position[0] + 1) * 8) + Math.floor((position[1] + 1) * 8)) % 2 === 1 ? 0 : 1;
    color = directReference(surface, position, [0, 0, 1], [0.8 * shadow, 0.6 * shadow, 0.4 * shadow]).map(
      (v, i) => v + emissive[i]
    );
    for (const light of pointLights.slice(0, lights)) {
      const delta = light.position.map((v, i) => v - position[i]);
      const attenuation = lightSphereDistanceAttenuation(Math.hypot(...delta), light.radius, light.distance);
      const direct = directReference(
        surface,
        position,
        normalize(delta),
        light.color.map((v) => v * attenuation)
      );
      color = color.map((v, i) => v + direct[i]);
    }
    if (stage >= 5) {
      color = color.map(
        (v, i) =>
          v +
          (([0.2, 0.25, 0.3][i] * base[i] * (1 - surface.metallic)) / Math.PI +
            [0.25, 0.3, 0.35][i] * ((0.04 + (base[i] - 0.04) * surface.metallic) * 0.5 + 0.2) +
            [0.25, 0.3, 0.35][i] * surface.coat[0] * 0.04) *
            surface.occlusion
      );
    }
  }
  return workingColor(color).map((v) => v * 1.25);
}

function aluReference(pixel) {
  const seed = pixel * 0.000013;
  const fract = (v) => v - Math.floor(v);
  let value = Array(3).fill(fract(seed) * 0.1 + 0.02);
  for (let i = 0; i < 32; i++) {
    const phase = fract(seed + value[0] * 0.371 + i * 0.013);
    const noL = 0.1 + phase * 0.8;
    const noV = 0.1 + fract(seed * 0.73 + value[1]) * 0.8;
    const noH2 = 0.05 + fract(phase * 0.57 + value[2]) * 0.85;
    const voH = 0.1 + fract(phase + value[1] * 0.13) * 0.8;
    const alpha = 0.1 + fract(phase + value[2] * 0.21) * 0.6;
    const a2 = alpha * alpha;
    const visibility =
      0.5 / (noL * Math.sqrt(noV * noV * (1 - a2) + a2) + noV * Math.sqrt(noL * noL * (1 - a2) + a2));
    const distribution = a2 / (Math.PI * (noH2 * (a2 - 1) + 1) ** 2);
    value = value.map((v) => (v + (1 - v) * (1 - voH) ** 5) * visibility * distribution * 0.01 + 0.02);
  }
  return value;
}

function costCard(variant, visiblePixels, compactBytes) {
  const split = variant.name === "Compact44";
  const lit = variant.stage >= 2 && variant.stage !== 6;
  const shadow = lit && variant.stage >= 4;
  const ibl = variant.stage === 5;
  const materialQueries = variant.stage === 0 ? 0 : variant.stage === 6 ? 1 : 5;
  // Upper logical record-load estimate, NOT DRAM bytes: a struct assignment
  // can be scalarized/DCE'd and adjacent lanes repeatedly read the same data.
  const geometryBytes = 24 + GPU_FRAME_INSTANCE_STRIDE + 16 + 12 + 48 + 3 * 4 * 16;
  const lightBytes = lit
    ? 16 + variant.lightCount * (4 + POINT_LIGHT_RECORD_TYPE.size) + DIRECTIONAL_LIGHT_RECORD_TYPE.size
    : 0;
  const pageBytes = shadow ? 4 * 32 : 0;
  const sequential = PIXELS * (split ? 16 : 12) + visiblePixels * (split ? COMPACT_RECORD_BYTES * 2 : 0);
  const random = visiblePixels * (geometryBytes + lightBytes + pageBytes);
  // Trilinear material query: 2 mips x 4 bilinear taps x rgba8. This is a
  // logical tap budget; normal/ORM/emissive/coat share cache lines per quad.
  const materialTexelBytes = materialQueries * 8 * 4;
  const providerTexelBytes = (shadow ? 4 * 4 : 0) + (ibl ? 21 * 8 : 0);
  const textureBytes = visiblePixels * (materialTexelBytes + providerTexelBytes);
  return {
    visiblePixels,
    tileCount: Math.ceil(WIDTH / 8) * Math.ceil(HEIGHT / 8),
    estimatedReadBytesPerVisiblePixel:
      geometryBytes +
      lightBytes +
      pageBytes +
      materialTexelBytes +
      providerTexelBytes +
      (split ? COMPACT_RECORD_BYTES + 8 : 4),
    writeBytesPerScreenPixel: 8,
    extraWriteBytesPerVisiblePixel: split ? COMPACT_RECORD_BYTES : 0,
    estimatedSequentialBytes: sequential,
    estimatedRandomStorageBytes: random,
    estimatedTextureTapBytes: textureBytes,
    estimatedLogicalBytes: sequential + random + textureBytes,
    textureQueriesPerVisiblePixel: materialQueries,
    vsmDepthTapsPerVisiblePixel: shadow ? 4 : 0,
    iblTexelLoadsPerVisiblePixel: ibl ? 21 : 0,
    approximateFlopPerVisiblePixel:
      350 + (materialQueries === 5 ? 130 : 0) + variant.lightCount * 180 + (lit ? 150 : 0) + (ibl ? 150 : 0),
    specialOpsPerVisiblePixel: {
      normalization: 5 + variant.lightCount * 2 + Number(lit),
      sqrt: lit ? (variant.lightCount + 1) * 2 : 0,
      pow: lit ? variant.lightCount + 1 : 0,
      log2: Number(lit) + Number(ibl)
    },
    dispatches: variant.programs.length,
    pipelineSwitches: variant.programs.length,
    atomics: 0,
    barriers: 0,
    scratchBytes: split ? compactBytes : 0,
    shadingHistoryBytes: 0,
    geometryUniqueWorkingSetEstimate: 32400 * (24 + 16 + 2 * 12 + 4 * 5 * 16) + GPU_FRAME_INSTANCE_STRIDE,
    qualification:
      "Logical operations/loads, not hardware counters. Prepared branch only; fallback source matrices are compiled but not executed in this fixture. Do not equate the full instance stride to physical per-pixel DRAM traffic."
  };
}

export async function runNativeSurfaceGpuNumericProbe(device) {
  return runNativeSurfaceGpuProbe(device, { numericOnly: true });
}

export async function runNativeSurfaceGpuProbe(device, { numericOnly = false } = {}) {
  check(device.features.has("timestamp-query"), "S0 requires actual GPU timestamps");
  const retained = [];
  let bufferBytes = 0;
  let textureBytes = 0;
  const makeBuffer = (dataOrSize, usage, label) => {
    const size = typeof dataOrSize === "number" ? dataOrSize : dataOrSize.byteLength;
    const buffer = device.createBuffer({ label, size, usage });
    if (typeof dataOrSize !== "number") {
      device.queue.writeBuffer(buffer, 0, dataOrSize);
    }
    retained.push(buffer);
    bufferBytes += size;
    return buffer;
  };
  const storage = (data, label) =>
    makeBuffer(data, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC, label);
  const uniform = (data, label) => makeBuffer(data, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST, label);
  const makeTexture = (width, height, format, usage, layers = 1, mipLevelCount = 1) => {
    const texture = device.createTexture({ size: [width, height, layers], format, usage, mipLevelCount });
    retained.push(texture);
    for (let mip = 0; mip < mipLevelCount; mip++) {
      textureBytes +=
        Math.max(1, width >> mip) * Math.max(1, height >> mip) * layers * (format === "rgba16float" ? 8 : 4);
    }
    return texture;
  };
  const uploadedTextureUsage = GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST;
  const arenaOwner = new FrameGeometryArena(device);
  const verticesOwner = new FrameGeometryVertices(device);
  const timer = new GPUTimer(device, 32);
  const timingRing = new GPUFrameTimingRing(device, 1, 16);
  try {
    const workCount = ((WIDTH / CELL) * HEIGHT) / CELL;
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
        currentObjectToWorld: identity,
        previousObjectToWorld: identity,
        dynamicRevision: 1
      })
    );
    const instanceFloats = new Float32Array(instance.buffer);
    instanceFloats.set(identity, GPU_FRAME_INSTANCE_OFFSETS.objectToClip / 4);
    instanceFloats.set([1, 0, 0, 1, 0, 1, 0, 0, 0, 0, 1, 0], GPU_FRAME_INSTANCE_OFFSETS.normalX / 4);
    new DataView(instance.buffer).setUint32(GPU_FRAME_INSTANCE_OFFSETS.generation, GENERATION, true);
    const instances = storage(instance, "S0/frame instance ABI");
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
      new Uint8Array(payload.buffer).set([0, 1, 2, 2, 1, 3, 0, 0], (triangleWordBase + slot * 2) * 4);
      for (let corner = 0; corner < 4; corner++) {
        const x = (((tileX + (corner & 1)) * CELL) / WIDTH) * 2 - 1;
        const y = 1 - (((tileY + (corner >> 1)) * CELL) / HEIGHT) * 2;
        payloadFloats.set(
          [0, 0, 1, 1, 1, 0, 0, 1, (x + 1) * 8, (y + 1) * 8, 0, 0, 1, 1, 1, 1, 0, 0, 0, 0, x, y, 0.5, 1],
          attributeWordBase + (slot * 4 + corner) * 24
        );
      }
      workBytes.set(
        packGpuMeshletRasterWork({
          instanceSlot: 0,
          geometrySlot: 0,
          meshletSlot: slot,
          materialSlotOrRange: 0,
          packedRasterFlags: 0,
          packedProfileLod: 0
        }),
        GPU_MESHLET_WORK_QUEUE_HEADER_STRIDE + slot * GPU_MESHLET_RASTER_WORK_RECORD_STRIDE
      );
    }
    const sourceMetadata = storage(metadata, "S0/asset metadata ABI");
    const vertexPayload = storage(payload, "S0/resident vertex payload ABI");
    const work = storage(workBytes, "S0/meshlet queue ABI");
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

    const parameterWords = new Uint32Array([
      0,
      geometryWords,
      0,
      triangleWordBase,
      0,
      0,
      0,
      arena.layout.header.offset / 4,
      WIDTH,
      HEIGHT,
      20,
      0,
      0,
      0,
      0,
      0
    ]);
    new Float32Array(parameterWords.buffer).set([0, 0, 3, 1.25], 12);
    const parameters = uniform(parameterWords, "S0/parameters");
    const view = uniform(new Uint32Array([WIDTH, HEIGHT, 0, 0]), "S0/light view");
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
    const hdr = makeTexture(
      WIDTH,
      HEIGHT,
      "rgba16float",
      GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC
    );
    const compact = storage(PIXELS * COMPACT_RECORD_BYTES, "S0/compact 44B record");
    const materialTexture = makeTexture(
      TEXTURE_SIZE,
      TEXTURE_SIZE,
      "rgba8unorm",
      uploadedTextureUsage,
      5,
      MIP_COUNT
    );
    for (let mip = 0; mip < MIP_COUNT; mip++) {
      const size = Math.max(1, TEXTURE_SIZE >> mip);
      const texels = new Uint8Array(size * size * 4 * 5);
      for (let layer = 0; layer < 5; layer++) {
        for (let y = 0; y < size; y++) {
          for (let x = 0; x < size; x++) {
            texels.set(materialTexel(layer, x, y, size), ((layer * size + y) * size + x) * 4);
          }
        }
      }
      device.queue.writeTexture(
        { texture: materialTexture, mipLevel: mip },
        texels,
        { bytesPerRow: size * 4, rowsPerImage: size },
        [size, size, 5]
      );
    }
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
    const lights = storage(lightWords, "S0/real light database ABI");
    // Same near/far mapping as LightClusterPass.packSettings. Lists are a
    // fixture, but geometry -> view depth -> logarithmic slice is real work.
    const offsetNear = 0.1 + 0.2;
    const zScale = 4.06;
    const blend = (100 - offsetNear * Math.pow(2, 23 / zScale)) / (100 - offsetNear);
    const clusterParameters = uniform(
      new Float32Array([(1 - blend) / offsetNear, blend, zScale, 0]),
      "S0/cluster parameters"
    );
    const clusterCount = Math.ceil(WIDTH / 32) * Math.ceil(HEIGHT / 32) * 24;
    const clusterLookup = storage(clusterCount * 16, "S0/cluster metadata ABI");
    const clusterData = storage(
      new Uint32Array([8, 8, 8, 0, 8, 0, 0, 0, 0, 1, 2, 3, 4, 5, 6, 7]),
      "S0/cluster index ABI"
    );
    const setLightCount = (count) => {
      const lookup = new Uint32Array(clusterCount * 4);
      for (let i = 0; i < clusterCount; i++) {
        lookup.set([0, count, 0, 0], i * 4);
      }
      device.queue.writeBuffer(clusterLookup, 0, lookup);
      device.queue.writeBuffer(clusterData, 16, new Uint32Array([count]));
    };
    const pages = new Uint32Array((16 * 16 + 8 * 8 + 4 * 4 + 2 * 2 + 1 + 1) * 8);
    for (let y = 0; y < 16; y++) {
      for (let x = 0; x < 16; x++) {
        pages.set([x, y, 0, 9, GENERATION, 0, 0, 0], (x + y * 16) * 8);
      }
    }
    const pageTable = storage(pages, "S0/resident VSM page ABI");
    const vsmValues = new Float32Array(60);
    vsmValues.set(identity);
    vsmValues.set([-1, -1, 2, 0], 16);
    new Uint32Array(vsmValues.buffer).set([16, 128, 2, 16, 1, GENERATION, 2, 2112], 40);
    const vsmConstants = uniform(vsmValues, "S0/VSM constants");
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

    const bufferEntry = (binding, type, visibility = GPUShaderStage.COMPUTE) => ({
      binding,
      visibility,
      buffer: { type }
    });
    const textureEntry = (binding, sampleType = "float", viewDimension = "2d") => ({
      binding,
      visibility: GPUShaderStage.COMPUTE,
      texture: { sampleType, viewDimension }
    });
    const layouts = [
      device.createBindGroupLayout({
        entries: [
          bufferEntry(0, "uniform"),
          ...[1, 2, 3, 4].map((i) => bufferEntry(i, "read-only-storage")),
          textureEntry(5, "uint"),
          textureEntry(6, "depth"),
          {
            binding: 7,
            visibility: GPUShaderStage.COMPUTE,
            storageTexture: { access: "write-only", format: "rgba16float" }
          },
          textureEntry(8, "float", "2d-array"),
          { binding: 9, visibility: GPUShaderStage.COMPUTE, sampler: { type: "filtering" } },
          bufferEntry(10, "storage")
        ]
      }),
      device.createBindGroupLayout({
        entries: [
          bufferEntry(0, "read-only-storage"),
          bufferEntry(1, "uniform"),
          bufferEntry(2, "read-only-storage"),
          bufferEntry(3, "read-only-storage"),
          bufferEntry(4, "uniform"),
          textureEntry(5),
          textureEntry(6),
          textureEntry(7)
        ]
      }),
      device.createBindGroupLayout({
        entries: [bufferEntry(0, "uniform"), bufferEntry(1, "read-only-storage"), textureEntry(2, "depth")]
      })
    ];
    const sampler = device.createSampler({
      minFilter: "linear",
      magFilter: "linear",
      mipmapFilter: "linear",
      addressModeU: "repeat",
      addressModeV: "repeat"
    });
    const groups = [
      [
        parameters,
        work,
        arena.buffer,
        vertexPayload,
        instances,
        visibility.createView(),
        depth.createView(),
        hdr.createView(),
        materialTexture.createView({ dimension: "2d-array" }),
        sampler,
        compact
      ],
      [
        lights,
        clusterParameters,
        clusterLookup,
        clusterData,
        view,
        diffuseEnvironment.createView(),
        specularEnvironment.createView(),
        dfg.createView()
      ],
      [vsmConstants, pageTable, atlas.createView()]
    ].map((resources, index) =>
      device.createBindGroup({
        layout: layouts[index],
        entries: resources.map((resource, binding) => ({
          binding,
          resource: resource instanceof GPUBuffer ? { buffer: resource } : resource
        }))
      })
    );
    const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: layouts });
    const compile = async (options, entryPoint = "main") => {
      const source = nativeSurfaceProbeWgsl(options);
      const module = device.createShaderModule({
        label: `S0/${JSON.stringify(options)}/${entryPoint}`,
        code: source
      });
      const info = await module.getCompilationInfo();
      const errors = info.messages.filter((message) => message.type === "error");
      check(
        errors.length === 0,
        errors.map((message) => `${message.lineNum}: ${message.message}`).join("\n")
      );
      const pipeline = await device.createComputePipelineAsync({
        layout: pipelineLayout,
        compute: { module, entryPoint }
      });
      const encodedSource = new TextEncoder().encode(source);
      const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", encodedSource));
      const sourceSha256 = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
      return { pipeline, sourceBytes: encodedSource.length, sourceSha256 };
    };
    const variants = [];
    for (const [name, stage, lightCount] of [
      ["G", 0, 0],
      ["GM", 1, 0],
      ["GML4", 2, 4],
      ["GML8", 3, 8],
      ["GML8V", 4, 8],
      ["GML8VI", 5, 8],
      ["Unlit", 6, 0]
    ]) {
      console.log(`S0 compile ${name}`);
      variants.push({ name, stage, lightCount, programs: [await compile({ stage })] });
    }
    variants.push({
      name: "Compact44",
      stage: 5,
      lightCount: 8,
      programs: [await compile({ stage: 5, split: true }), await compile({ stage: 5, resolve: true })]
    });
    const aluProgram = await compile({ stage: 0 }, "alu_probe");
    const rasterLayout = device.createBindGroupLayout({
      entries: [0, 1, 2].map((binding) =>
        bufferEntry(
          binding,
          binding === 0 ? "uniform" : "read-only-storage",
          GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT
        )
      )
    });
    const rasterModule = device.createShaderModule({ code: PROBE_VISIBILITY_WGSL });
    const rasterPipeline = await device.createRenderPipelineAsync({
      layout: device.createPipelineLayout({ bindGroupLayouts: [rasterLayout] }),
      vertex: { module: rasterModule, entryPoint: "vertex_main" },
      fragment: { module: rasterModule, entryPoint: "fragment_main", targets: [{ format: "r32uint" }] },
      primitive: { topology: "triangle-list" },
      depthStencil: { format: "depth32float", depthWriteEnabled: true, depthCompare: "always" }
    });
    const rasterGroup = device.createBindGroup({
      layout: rasterLayout,
      entries: [parameters, work, arena.buffer].map((buffer, binding) => ({ binding, resource: { buffer } }))
    });
    const bytesPerRow = WIDTH * 8;
    const output = makeBuffer(
      PIXELS * 8,
      GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      "S0/HDR oracle readback"
    );
    const winnerOutput = makeBuffer(
      PIXELS * 4,
      GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      "S0/winner oracle readback"
    );
    const encodeShading = (encoder, variant, timed, session) => {
      for (const [i, program] of variant.programs.entries()) {
        const pass = encoder.beginComputePass({
          label: variant.name + "/" + i,
          ...(timed ? { timestampWrites: session.writes(variant.name + "/" + i, "compute") } : {})
        });
        pass.setPipeline(program.pipeline);
        groups.forEach((group, index) => pass.setBindGroup(index, group));
        pass.dispatchWorkgroups(Math.ceil(WIDTH / 8), Math.ceil(HEIGHT / 8));
        pass.end();
      }
    };
    const measure = async (variant, repeats = 9) => {
      const samples = [],
        passSamples = [],
        encodeSamples = [],
        spanSamples = [];
      for (let frame = 0; frame < repeats + 3; frame++) {
        const session = timingRing.acquire("full");
        check(session !== null, "S0 timing ring has no available session");
        const encoder = device.createCommandEncoder();
        const start = performance.now();
        session.begin(encoder);
        encodeShading(encoder, variant, true, session);
        session.resolve(encoder);
        encodeSamples.push(performance.now() - start);
        device.queue.submit([encoder.finish()]);
        const results = await session.download();
        const times = results.filter((result) => result.scope === "pass").map((result) => result.duration_ms);
        const span = results.find((result) => result.scope === "span");
        check(span !== undefined, "S0 missing command span");
        if (frame >= 3) {
          samples.push(times.reduce((a, b) => a + b, 0));
          passSamples.push(times);
          spanSamples.push(span.duration_ms);
        }
      }
      const chronologicalSamplesMs = samples.slice();
      samples.sort((a, b) => a - b);
      spanSamples.sort((a, b) => a - b);
      return {
        gpuP50Ms: samples[Math.floor(samples.length / 2)],
        gpuP95Ms: samples[Math.min(samples.length - 1, Math.ceil(samples.length * 0.95) - 1)],
        gpuSamplesMs: samples,
        chronologicalSamplesMs,
        commandSpanP50Ms: spanSamples[Math.floor(spanSamples.length / 2)],
        commandSpanSamplesMs: spanSamples,
        discardedWarmupSamples: 3,
        timingMarkerPasses: 2,
        passSamplesMs: passSamples,
        cpuEncodeP50Ms: encodeSamples.sort((a, b) => a - b)[Math.floor(encodeSamples.length / 2)]
      };
    };
    const reports = [];
    const stabilityChecks = [];
    const fallbackReports = [];
    for (const coverageDivisor of numericOnly ? [20] : [20, 2]) {
      parameterWords[10] = coverageDivisor;
      device.queue.writeBuffer(parameters, 0, parameterWords);
      const rasterEncoder = device.createCommandEncoder();
      const rasterPass = rasterEncoder.beginRenderPass({
        colorAttachments: [
          {
            view: visibility.createView(),
            clearValue: { r: 0xffffffff, g: 0, b: 0, a: 0 },
            loadOp: "clear",
            storeOp: "store"
          }
        ],
        depthStencilAttachment: {
          view: depth.createView(),
          depthClearValue: 0,
          depthLoadOp: "clear",
          depthStoreOp: "store"
        }
      });
      rasterPass.setPipeline(rasterPipeline);
      rasterPass.setBindGroup(0, rasterGroup);
      rasterPass.draw(6, workCount);
      rasterPass.end();
      rasterEncoder.copyTextureToBuffer(
        { texture: visibility },
        { buffer: winnerOutput, bytesPerRow: WIDTH * 4 },
        [WIDTH, HEIGHT]
      );
      device.queue.submit([rasterEncoder.finish()]);
      await winnerOutput.mapAsync(GPUMapMode.READ);
      const winners = new Uint32Array(winnerOutput.getMappedRange()).slice();
      winnerOutput.unmap();
      const visiblePixels = winners.reduce((count, key) => count + Number(key !== 0xffffffff), 0);
      check(
        visiblePixels === PIXELS * (1 - 1 / coverageDivisor),
        `Unexpected hardware coverage ${visiblePixels}`
      );
      if (!numericOnly) {
        // Prime the complete workload before the first measured variant. Keep
        // this explicit and retain end-of-series controls: no clock telemetry
        // is available, so stationarity must not be silently assumed.
        setLightCount(8);
        const warmEncoder = device.createCommandEncoder();
        for (let frame = 0; frame < 24; frame++) {
          encodeShading(
            warmEncoder,
            variants.find((variant) => variant.name === "GML8VI"),
            false
          );
        }
        device.queue.submit([warmEncoder.finish()]);
        await device.queue.onSubmittedWorkDone();
      }
      const sampledPixels = [
        [33, 57],
        [311, 217],
        [731, 599],
        [1149, 877],
        [1883, 1021]
      ];
      let fusedImage;
      for (const variant of variants) {
        setLightCount(variant.lightCount);
        const times = numericOnly ? {} : await measure(variant);
        const encoder = device.createCommandEncoder();
        encodeShading(encoder, variant, false);
        encoder.copyTextureToBuffer({ texture: hdr }, { buffer: output, bytesPerRow }, [WIDTH, HEIGHT]);
        device.queue.submit([encoder.finish()]);
        await output.mapAsync(GPUMapMode.READ);
        const image = new Uint16Array(output.getMappedRange()).slice();
        output.unmap();
        let worstNumericError = 0;
        for (const [x, y] of sampledPixels) {
          const expected = expectedPixel(x, y, variant.stage, variant.lightCount);
          for (let channel = 0; channel < 3; channel++) {
            const actual = decodeFloat16(image[(x + y * WIDTH) * 4 + channel]);
            const error = Math.abs(actual - expected[channel]);
            worstNumericError = Math.max(worstNumericError, error);
            check(
              error <= 0.004 + Math.abs(expected[channel]) * 0.004,
              `${variant.name} pixel ${x},${y} ch${channel}: ${actual} != ${expected[channel]}`
            );
          }
        }
        check(image[3] === 0, `${variant.name}: background not zero`);
        if (variant.name === "GML8VI") {
          fusedImage = image;
        }
        let splitMaxError = null;
        if (variant.name === "Compact44") {
          splitMaxError = 0;
          for (let i = 0; i < image.length; i++) {
            const a = decodeFloat16(image[i]),
              b = decodeFloat16(fusedImage[i]);
            check(Number.isFinite(a) && Number.isFinite(b), "Nonfinite native HDR");
            splitMaxError = Math.max(splitMaxError, Math.abs(a - b));
            check(
              Math.abs(a - b) <= 0.004 + Math.abs(b) * 0.004,
              `Compact precision error at ${i}: ${a} vs ${b}`
            );
          }
        }
        const card = costCard(variant, visiblePixels, compact.size);
        reports.push({
          name: variant.name,
          coverage: visiblePixels / PIXELS,
          ...times,
          worstNumericError,
          splitMaxError,
          sourceBytes: variant.programs.map((program) => program.sourceBytes),
          sourceSha256: variant.programs.map((program) => program.sourceSha256),
          card
        });
        console.log(
          `S0 ${coverageDivisor} ${variant.name}: ${numericOnly ? "numeric" : times.gpuP50Ms.toFixed(3) + " ms"}`
        );
      }
      if (!numericOnly) {
        for (const name of ["G", "GM", "GML8", "GML8V", "GML8VI"]) {
          const variant = variants.find((item) => item.name === name);
          setLightCount(variant.lightCount);
          stabilityChecks.push({ name, coverage: visiblePixels / PIXELS, ...(await measure(variant, 5)) });
        }
      }
      // Select an invalid prepared-directory header: the immutable source
      // metadata remains at the arena prefix. Exercise the actual resident
      // decoder/matrices against the SAME hardware winners and payload.
      const preparedHeader = parameterWords[7];
      parameterWords[7] = 0;
      device.queue.writeBuffer(parameters, 0, parameterWords);
      setLightCount(8);
      const fullVariant = variants.find((item) => item.name === "GML8VI");
      const fallbackTimes = numericOnly ? {} : await measure(fullVariant);
      const fallbackEncoder = device.createCommandEncoder();
      encodeShading(fallbackEncoder, fullVariant, false);
      fallbackEncoder.copyTextureToBuffer({ texture: hdr }, { buffer: output, bytesPerRow }, [WIDTH, HEIGHT]);
      device.queue.submit([fallbackEncoder.finish()]);
      await output.mapAsync(GPUMapMode.READ);
      const fallbackImage = new Uint16Array(output.getMappedRange()).slice();
      output.unmap();
      let fallbackMaxError = 0;
      for (let i = 0; i < fallbackImage.length; i++) {
        const actual = decodeFloat16(fallbackImage[i]);
        const expected = decodeFloat16(fusedImage[i]);
        fallbackMaxError = Math.max(fallbackMaxError, Math.abs(actual - expected));
        check(
          Number.isFinite(actual) && Math.abs(actual - expected) <= 0.004 + Math.abs(expected) * 0.004,
          `Resident fallback error at ${i}: ${actual} != ${expected}`
        );
      }
      fallbackReports.push({
        coverage: visiblePixels / PIXELS,
        visiblePixels,
        ...fallbackTimes,
        fallbackMaxError,
        sourceMode: "Actual resident payload/instance matrix path; same winner, identity-transform fixture"
      });
      parameterWords[7] = preparedHeader;
      device.queue.writeBuffer(parameters, 0, parameterWords);
    }
    if (numericOnly) {
      return {
        passed: true,
        scope: "Isolated native numeric/compact oracle only, no performance measurement",
        reports,
        fallbackReports
      };
    }
    setLightCount(0);
    const alu = await measure({ name: "ALU32BRDF", programs: [aluProgram] }, 5);
    const aluEncoder = device.createCommandEncoder();
    aluEncoder.copyTextureToBuffer({ texture: hdr }, { buffer: output, bytesPerRow }, [WIDTH, HEIGHT]);
    device.queue.submit([aluEncoder.finish()]);
    await output.mapAsync(GPUMapMode.READ);
    const aluImage = new Uint16Array(output.getMappedRange()).slice();
    output.unmap();
    for (const [x, y] of [
      [0, 0],
      [731, 599],
      [1919, 1079]
    ]) {
      const reference = aluReference(x + y * WIDTH);
      for (let channel = 0; channel < 3; channel++) {
        const actual = decodeFloat16(aluImage[(x + y * WIDTH) * 4 + channel]);
        check(Math.abs(actual - reference[channel]) < 0.0002, `ALU calibration sink ${x},${y}/${channel}`);
      }
    }
    const calibration = await calibrateStorageAndTextures(
      device,
      timer,
      makeBuffer,
      materialTexture,
      sampler
    );
    calibration.alu32Brdf = {
      ...alu,
      brdfEvaluations: PIXELS * 32,
      estimatedFlopPerEvaluation: 100,
      effectiveEstimatedGFlopPerSecond: (PIXELS * 32 * 100) / (alu.gpuP50Ms * 1e6),
      sinkOracle: "3 independent double-precision recurrence samples",
      qualification:
        "100 estimated scalar FLOP/evaluation INCLUDING varying input/recurrence overhead, 2 sqrt and divisions; this is a dependent BRDF profile, not a peak ALU counter."
    };
    const high = reports.filter((report) => report.coverage > 0.9);
    const time = (name) => high.find((report) => report.name === name).gpuP50Ms;
    for (const report of reports) {
      report.floors = {
        mandatoryStreamingMs:
          report.card.estimatedSequentialBytes / (calibration.readWrite.effectiveGBps * 1e6),
        estimatedComputeProfileMs:
          (report.card.visiblePixels * report.card.approximateFlopPerVisiblePixel) /
          (calibration.alu32Brdf.effectiveEstimatedGFlopPerSecond * 1e6),
        uncachedLogicalRandomStorageMs:
          report.card.estimatedRandomStorageBytes / (calibration.random.effectiveGBps * 1e6),
        materialQueryLocalityMs: [calibration.textureLocal, calibration.textureRandom].map(
          (profile) =>
            (report.card.visiblePixels * report.card.textureQueriesPerVisiblePixel) /
            (profile.effectiveGQueriesPerSecond * 1e6)
        ),
        qualification:
          "Mandatory framebuffer/compact streaming is the bandwidth lower-bound estimate. Dependent BRDF gives a compute-profile estimate, not a universal floor. Uncached logical random-storage time is a stress bound, NOT a floor: coherent winner/instance/triangle/light reuse is essential. Storage and texture operations overlap; these terms are not additive counters."
      };
    }
    return {
      passed: true,
      scope: "S0 isolated native useful-work experiment, NOT production renderer performance",
      resolution: [WIDTH, HEIGHT],
      workCount,
      primitives: workCount * 2,
      profiles:
        "Linear standard PBR + normal/ORM/emissive/coat; 4/8 clustered point lights plus one directional; resident 2x2-PCF VSM; octahedral IBL",
      simplifiedInputs: [
        "Deterministic orthographic tessellated fixture; no production Scene streaming/culling/alpha producer. Hardware-generated winner, actual frame-geometry producer and production source ABI/math are consumed.",
        "Light database, cluster list and VSM residency/constants are ABI fixtures, not measured producer execution. All lights cover every cluster; page table has 256 resident pages with checkerboard real depth raster.",
        "One compatible material array, linear-color profile, identity transform; environment/DFG texels constant nonzero. TextureResidency routes, arbitrary graph, perspective/negative determinant, alpha and real-world resource entropy need subsequent evidence.",
        "Probe allocates both fused and compact resources for comparison; a fused production profile would not allocate compact scratch or oracle readback."
      ],
      reports,
      stabilityChecks,
      fallbackReports,
      calibration,
      measurementProtocol:
        "24 complete untimed dispatches per coverage, then 3 per-variant warmups and 9 timed samples; 5-sample end controls. P95 of 9 is the sample maximum, not a long-run tail guarantee.",
      decompositionMs: {
        geometry: time("G"),
        materialIncrement: time("GM") - time("G"),
        direct4PlusDirectionalIncrement: time("GML4") - time("GM"),
        direct8PlusDirectionalIncrement: time("GML8") - time("GM"),
        fourToEightIncrement: time("GML8") - time("GML4"),
        vsmIncrement: time("GML8V") - time("GML8"),
        iblIncrement: time("GML8VI") - time("GML8V"),
        compactMinusFused: time("Compact44") - time("GML8VI"),
        qualification:
          "Differences of independently compiled kernels; DCE/live ranges/cache/scheduling mean these are not additive hardware counters."
      },
      workingSet: {
        bufferBytesIncludingReadbackAndCalibration: bufferBytes,
        estimatedTextureBytes: textureBytes,
        geometryArenaBytes: arenaOwner.allocatedBytes,
        geometryProducerBytes: verticesOwner.allocatedBytes,
        compactBytes: compact.size,
        timerBytes: timer.allocatedBytes + timingRing.evidence().bufferBytes,
        persistentShadingHistoryBytes: 0
      },
      viability: "MEASUREMENT ONLY",
      viabilityReason:
        "Assertions validate this fixture only. Review costs, stationarity controls, source simplifications and production limits in the execution authority before deciding S0. Benchmark pass is not automatic S1 admission or a production performance claim."
    };
  } finally {
    await device.queue.onSubmittedWorkDone();
    timer.destroy();
    timingRing.destroy();
    verticesOwner.destroy();
    arenaOwner.destroy();
    retained.forEach((resource) => resource.destroy());
  }
}

async function calibrateStorageAndTextures(device, timer, makeBuffer, materialTexture, sampler) {
  const count = 2 * 1024 * 1024;
  const data = new Float32Array(count * 4);
  for (let i = 0; i < data.length; i++) {
    data[i] = (i % 1024) / 1024;
  }
  const input = makeBuffer(
    data,
    GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    "S0/calibration 32MiB input"
  );
  const output = makeBuffer(
    data.byteLength,
    GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    "S0/calibration sink"
  );
  const readback = makeBuffer(48, GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ, "S0/calibration oracle");
  const textureReference = (lane, random) => {
    const result = [0, 0, 0, 0];
    let address = lane;
    for (let i = 0; i < 16; i++) {
      address = (Math.imul(address, 1664525) + 1013904223) >>> 0;
      const x = random ? address & 511 : lane % 512;
      const y = random ? (address >>> 9) & 511 : (Math.floor(lane / 512) + i) % 512;
      for (const dy of [-1, 0]) {
        for (const dx of [-1, 0]) {
          const texel = materialTexel(i % 5, (x + dx + 512) % 512, (y + dy + 512) % 512, 512);
          texel.forEach((v, channel) => {
            result[channel] += v / (255 * 4);
          });
        }
      }
    }
    return result;
  };
  const source = /* wgsl */ `
@group(0) @binding(0) var<storage,read> input:array<vec4f>;
@group(0) @binding(1) var<storage,read_write> output:array<vec4f>;
@group(0) @binding(2) var image:texture_2d_array<f32>;
@group(0) @binding(3) var sample_state:sampler;
@compute @workgroup_size(64) fn calibration_read_write(@builtin(global_invocation_id) id:vec3u) {
  if id.x>=${count}u { return; } output[id.x]=input[id.x]+vec4f(0.01);
}
@compute @workgroup_size(64) fn read_only(@builtin(global_invocation_id) id:vec3u) {
  if id.x>=${count / 4}u { return; }
  let base=id.x*4u; output[id.x]=input[base]+input[base+1u]+input[base+2u]+input[base+3u];
}
@compute @workgroup_size(64) fn write_only(@builtin(global_invocation_id) id:vec3u) {
  if id.x>=${count}u { return; } output[id.x]=vec4f(f32(id.x));
}
@compute @workgroup_size(64) fn random_gather(@builtin(global_invocation_id) id:vec3u) {
  if id.x>=${count}u { return; }
  let address=(id.x*1664525u+1013904223u)&${count - 1}u;
  output[id.x]=input[address];
}
@compute @workgroup_size(64) fn texture_local(@builtin(global_invocation_id) id:vec3u) {
  if id.x>=${count}u { return; }
  var value=vec4f(0.0);
  for(var i=0u;i<16u;i++) { value+=textureSampleLevel(image,sample_state,vec2f(f32(id.x%512u),f32((id.x/512u+i)%512u))/512.0,i32(i%5u),0.0); }
  output[id.x]=value;
}
@compute @workgroup_size(64) fn texture_random(@builtin(global_invocation_id) id:vec3u) {
  if id.x>=${count}u { return; }
  var value=vec4f(0.0); var address=id.x;
  for(var i=0u;i<16u;i++) {
    address=address*1664525u+1013904223u;
    value+=textureSampleLevel(image,sample_state,vec2f(f32(address&511u),f32((address>>9u)&511u))/512.0,i32(i%5u),0.0);
  }
  output[id.x]=value;
}
@compute @workgroup_size(1) fn overhead() { output[0]+=vec4f(0.001); }
`;
  const module = device.createShaderModule({ code: source });
  const reports = {};
  for (const [name, entry, work, bytes] of [
    ["readWrite", "calibration_read_write", count, data.byteLength * 2],
    ["read", "read_only", count / 4, data.byteLength * 1.25],
    ["write", "write_only", count, data.byteLength],
    ["random", "random_gather", count, data.byteLength * 2],
    ["textureLocal", "texture_local", count, data.byteLength],
    ["textureRandom", "texture_random", count, data.byteLength],
    ["dispatch", "overhead", 1, 16]
  ]) {
    const pipeline = await device.createComputePipelineAsync({
      layout: "auto",
      compute: { module, entryPoint: entry }
    });
    const entries = [{ binding: 1, resource: { buffer: output } }];
    if (["calibration_read_write", "read_only", "random_gather"].includes(entry)) {
      entries.unshift({ binding: 0, resource: { buffer: input } });
    }
    if (entry.startsWith("texture")) {
      entries.push(
        { binding: 2, resource: materialTexture.createView({ dimension: "2d-array" }) },
        { binding: 3, resource: sampler }
      );
    }
    const group = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries });
    const samples = [];
    for (let iteration = 0; iteration < 8; iteration++) {
      timer.reset();
      const encoder = device.createCommandEncoder();
      const pass = encoder.beginComputePass({ timestampWrites: timer.getComputeWrites(name) });
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, group);
      pass.dispatchWorkgroups(Math.ceil(work / 64));
      pass.end();
      timer.resolve(encoder);
      device.queue.submit([encoder.finish()]);
      await timer.download_results();
      if (iteration >= 3) {
        samples.push(timer.results_to_console_table()[0].duration_ms);
      }
    }
    const addresses = [0, Math.floor(work / 2), work - 1];
    const oracleEncoder = device.createCommandEncoder();
    addresses.forEach((address, index) =>
      oracleEncoder.copyBufferToBuffer(output, address * 16, readback, index * 16, 16)
    );
    device.queue.submit([oracleEncoder.finish()]);
    await readback.mapAsync(GPUMapMode.READ);
    const actual = new Float32Array(readback.getMappedRange()).slice();
    readback.unmap();
    for (const [index, lane] of addresses.entries()) {
      let expected;
      if (entry === "calibration_read_write") {
        expected = Array.from(data.subarray(lane * 4, lane * 4 + 4), (v) => v + 0.01);
      } else if (entry === "read_only") {
        expected = [0, 1, 2, 3].map((channel) =>
          [0, 1, 2, 3].reduce((sum, corner) => sum + data[(lane * 4 + corner) * 4 + channel], 0)
        );
      } else if (entry === "write_only") {
        expected = Array(4).fill(lane);
      } else if (entry === "random_gather") {
        const at = (Math.imul(lane, 1664525) + 1013904223) & (count - 1);
        expected = Array.from(data.subarray(at * 4, at * 4 + 4));
      } else {
        expected = textureReference(lane, entry !== "texture_local").map(
          (v) => v + (entry === "overhead" ? 0.008 : 0)
        );
      }
      expected.forEach((v, channel) =>
        check(
          Math.abs(actual[index * 4 + channel] - v) < 0.0002,
          `${name} calibration sink lane ${lane}/${channel}: ${actual[index * 4 + channel]} != ${v}`
        )
      );
    }
    samples.sort((a, b) => a - b);
    const median = samples[2];
    reports[name] = {
      gpuP50Ms: median,
      gpuSamplesMs: samples,
      bytes,
      effectiveGBps: bytes / (median * 1e6),
      sinkOracle: "3 samples checked outside timing",
      ...(entry.startsWith("texture")
        ? {
            queries: count * 16,
            effectiveGQueriesPerSecond: (count * 16) / (median * 1e6),
            qualification:
              "16 bilinear level-0 queries per lane; output traffic and loop/coordinate ALU included."
          }
        : {})
    };
  }
  return reports;
}
