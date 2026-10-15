import { GraphicsContext } from "../../.test-dist/gpu/GraphicsContext.js";
import { ShadeGPUCommandContext } from "../../.test-dist/framegraph/ShadeGPUCommandContext.js";
import { TextureResidency } from "../../.test-dist/gpu/TextureResidency.js";
import { TiledTextureSource } from "../../.test-dist/assets/TiledTextureSource.js";
import { TiledTextureCook } from "../../.test-dist/assets/codec/TiledTextureCook.js";
import { initializePcTextureCodecs, cookPcTextureRgba } from "../../.test-dist/assets/codec/PcTextureCook.js";
import { ShadeTexture } from "../../.test-dist/texture/ShadeTexture.js";
import { StandardShadeMaterial } from "../../.test-dist/material/StandardShadeMaterial.js";
import {
  AppearanceGraphBuilder,
  snapshotAppearanceTexture
} from "../../.test-dist/material/AppearanceGraph.js";
import { compileAppearanceGraph } from "../../.test-dist/material/AppearanceGraphCompiler.js";
import { createNativeMaterialBindings } from "../../.test-dist/gpu/NativeMaterialBindings.js";
import { lowerNativeMaterial } from "../../.test-dist/shaders/native_material.js";
import { VIRTUAL_TEXTURE_FEEDBACK_WGSL } from "../../.test-dist/shaders/virtual_texture.js";

const check = (value, message) => {
  if (!value) throw new Error(message);
};
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

// Independent translation of pinned LibVT::mipmapLevel. The oracle does not
// import a production LOD helper. Wicked's two explicit mip queries are then
// sampled from independent reconstructed per-mip textures with real addressing.
// Reconstruction consumes immutable cold tiles, never the production atlas or
// page table. It validates GPU routing/filtering, not BC encoder quality.
function lod(dx, dy, width, height, linear, levels) {
  const f = Math.fround;
  const length = (v) => {
    const x = f(f(v[0]) * width),
      y = f(f(v[1]) * height);
    return f(f(x * x) + f(y * y));
  };
  const x = length(dx),
    y = length(dy);
  const major = Math.max(x, y),
    minor = Math.min(x, y);
  const ratio = linear ? Math.min(Math.ceil(f(major / Math.max(minor, f(1e-30)))), 64) : 1;
  return Math.min(levels - 1, Math.max(0, Math.log2(Math.max(major / Math.max(ratio, 1), 1e-30)) / 2));
}

async function fixture(codecs, semantic) {
  const payloads = [];
  let offset = 0;
  const cook = new TiledTextureCook(
    codecs,
    {
      addresses: ["clamp", "repeat", "mirror"],
      packUri: "oracle.vtpack",
      async writePayload(bytes, hash) {
        const start = offset;
        offset += bytes.length;
        payloads.push(bytes.slice());
        return { offset: start, shard: `${hash}.bin` };
      }
    },
    0
  );
  const width = 260,
    height = 132,
    rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const stripe = ((x >> 2) + (y >> 2)) % 2;
      rgba.set(
        semantic === "normal-linear"
          ? [100 + stripe * 32, 115 + (y % 3) * 8, 245, 255]
          : [40 + stripe * 170, 50 + (x % 17) * 10, 70 + (y % 13) * 12, 255],
        (y * width + x) * 4
      );
    }
  const { product } = await cookPcTextureRgba(
    codecs,
    rgba,
    width,
    height,
    { semantic, channel: 0, sourceUri: `oracle://filter/${semantic}` },
    undefined,
    (mip) => cook.appendMip(mip)
  );
  const tiled = await cook.finish(product);
  let retained = 0;
  const preparation = {
    evidence: () => ({ tiled: { retained } }),
    async readTiledPayloads(_session, _directory, ids) {
      retained++;
      const values = ids.map((id) => ({ id, bytes: payloads[id].slice().buffer }));
      return {
        payloads: values,
        release() {
          retained--;
          for (const value of values) structuredClone(value.bytes, { transfer: [value.bytes] });
        }
      };
    }
  };
  return {
    product,
    payloads,
    source: new TiledTextureSource(preparation, "filter", tiled.directory),
    preparation
  };
}

export async function runStreamingVtFilterGpuOracle(device) {
  const graphics = new GraphicsContext(device),
    reports = [];
  const codecs = await initializePcTextureCodecs();
  try {
    for (const semantic of ["occlusion-linear", "base-color-srgb", "normal-linear"]) {
      const cold = await fixture(codecs, semantic),
        residency = new TextureResidency(graphics);
      const textures = [],
        buffers = [];
      try {
        const materials = [0, 1, 2].map((address) => {
          const texture = ShadeTexture.fromTiled(cold.source);
          texture.wrapS = texture.wrapT = address;
          const material = new StandardShadeMaterial();
          if (semantic === "occlusion-linear") material.texture_occlusion = texture;
          else if (semantic === "normal-linear") material.texture_normal = texture;
          else material.texture_albedo = texture;
          return { texture, material };
        });
        const upload = ShadeGPUCommandContext.create(graphics, "Renderer/visibility-frame");
        const stage = residency.stage(
          materials.map((entry) => entry.material),
          upload
        );
        await residency.uploadTiled(
          materials.map((entry) => entry.material),
          upload
        );
        upload.finish();
        await upload.gpuDone;
        const vt = residency.virtualTextures;
        const plane = cold.product.metadata.planes[0],
          levels = plane.mips.length;
        // Independent decoded full-domain reference at the physical sampling
        // extent. Equal extents avoid driver anisotropic kernel choices varying
        // with the original resource's dimensions/base mip. Every texel comes
        // from immutable cooked tiles including BC-quantized gutters, never
        // from the runtime VT atlas or lookup. Whole-Product edge blocks can
        // differ because they encode different padded texels.
        const coldTiles = device.createTexture({
          size: [144, 144, cold.payloads.length],
          format: plane.format,
          usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING
        });
        textures.push(coldTiles);
        const blockBytes = plane.format === "bc4-r-unorm" ? 8 : 16;
        for (const [index, bytes] of cold.payloads.entries())
          device.queue.writeTexture(
            { texture: coldTiles, origin: [0, 0, index] },
            bytes,
            { bytesPerRow: 36 * blockBytes, rowsPerImage: 36 },
            [144, 144, 1]
          );
        const referenceModule = device.createShaderModule({
          code: `
@group(0) @binding(0) var original: texture_2d_array<f32>;
@group(0) @binding(1) var destination: texture_storage_2d<rgba16float, write>;
struct Settings { level: u32, address: u32, width: u32, height: u32,
  first: u32, grid: u32, tail: u32, unused: u32, origin: vec2u, padding: vec2u }
@group(0) @binding(2) var<uniform> settings: Settings;
fn address(value: i32, size: i32) -> i32 {
  if settings.address == 0u { return clamp(value, 0, size - 1); }
  let period = select(size, size * 2, settings.address == 2u);
  let wrapped = ((value % period) + period) % period;
  return select(wrapped, period - 1 - wrapped, settings.address == 2u && wrapped >= size);
}
@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {
  if any(id.xy >= vec2u(2304u)) { return; }
  let extent = vec2i(i32(settings.width), i32(settings.height));
  let coordinate = vec2i(id.xy) - vec2i(8);
  let source = clamp(coordinate, vec2i(-8), extent + 7);
  let tile = clamp(vec2i(floor(vec2f(source) / 128.0)), vec2i(0), (extent - 1) / 128);
  let layer = settings.first + select(u32(tile.y) * settings.grid + u32(tile.x), 0u, settings.tail == 1u);
  let local = select(source - tile * 128, source + vec2i(settings.origin), settings.tail == 1u) + 8;
  textureStore(destination, vec2i(id.xy), textureLoad(original, local, i32(layer), 0));
}`
        });
        const referencePipeline = await device.createComputePipelineAsync({
          layout: "auto",
          compute: { module: referenceModule, entryPoint: "main" }
        });
        for (const refined of [false, true]) {
          if (refined) {
            const wanted = vt.snapshot.filter((page) => page && !page.pinned).map((page) => page.id);
            vt.observe({ frame: 1, view: 0, snapshot: vt.snapshot, wanted, used: [] });
            for (let attempt = 0; attempt < 100 && vt.evidence().resident < vt.evidence().pages; attempt++) {
              await tick();
              const command = ShadeGPUCommandContext.create(graphics, "Renderer/visibility-frame");
              vt.prepareFrame(command, attempt + 2, "");
              vt.encodeUploads(command);
              // Sampling in this oracle has its own command; do not publish an
              // artificial empty observation over the independently set demand.
              command.finish();
              await command.gpuDone;
            }
            check(vt.evidence().resident === vt.evidence().pages, "all requested fixture pages resident");
          }
          for (const { texture, material } of materials)
            for (const linear of [false, true]) {
              const independentMips = [];
              const referenceEncoder = device.createCommandEncoder();
              for (let level = 0; level < levels; level++) {
                const targetTexture = device.createTexture({
                  size: [2304, 2304],
                  format: "rgba16float",
                  usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING
                });
                independentMips.push(targetTexture);
                const profile = cold.source.directory.metadata.planes[texture.wrapS];
                const mip = profile.mips[level];
                const settings = device.createBuffer({
                  size: 48,
                  usage: GPUBufferUsage.UNIFORM,
                  mappedAtCreation: true
                });
                new Uint32Array(settings.getMappedRange()).set([
                  level,
                  texture.wrapS,
                  mip.width,
                  mip.height,
                  mip.payloads[0],
                  mip.gridWidth,
                  level >= profile.tailFirst ? 1 : 0,
                  0,
                  ...(mip.tailOrigin ?? [0, 0])
                ]);
                settings.unmap();
                buffers.push(settings);
                const pass = referenceEncoder.beginComputePass();
                pass.setPipeline(referencePipeline);
                pass.setBindGroup(
                  0,
                  device.createBindGroup({
                    layout: referencePipeline.getBindGroupLayout(0),
                    entries: [
                      { binding: 0, resource: coldTiles.createView({ dimension: "2d-array" }) },
                      { binding: 1, resource: targetTexture.createView() },
                      { binding: 2, resource: { buffer: settings } }
                    ]
                  })
                );
                pass.dispatchWorkgroups(288, 288);
                pass.end();
              }
              device.queue.submit([referenceEncoder.finish()]);
              texture.minFilter = texture.magFilter = linear ? 1 : 0;
              const builder = new AppearanceGraphBuilder(),
                uvNode = builder.input("uv0", 2, "surface", undefined, "uv0");
              const query = builder.texture(
                snapshotAppearanceTexture(
                  texture,
                  semantic === "base-color-srgb" ? "srgb-rgb" : "linear-rgb"
                ),
                uvNode
              );
              builder.output("rgba", semantic === "occlusion-linear" ? builder.swizzle(query, [0]) : query);
              const graph = compileAppearanceGraph(builder.build());
              const binding = createNativeMaterialBindings({
                graph,
                program: lowerNativeMaterial(graph),
                group: 1,
                bindingSet: stage.bindings.bindingSets.find(
                  (set) => set.id === stage.materialBindingSetIds.get(material)
                ),
                textureRoutingRefs: stage.materialTextureRoutingRefs.get(material),
                textureMipRanges: stage.textureMipRanges,
                texturePublications: stage.surfacePublications,
                obtainSampler: (descriptor) => graphics.samplers.obtain(descriptor)
              });
              const cases = [];
              // Nearest at an exact texel boundary is implementation-dependent:
              // atlas normalization and full-view normalization can round to
              // opposite sides. Probe both sides with a 0.01 texel separation.
              for (const uv of [
                [0.37, 0.61],
                [127.99 / 260, 0.97],
                [128.01 / 260, 0.97],
                [1, 1],
                [-0.003, 1.004],
                [-1.17, -0.31],
                [0.9999, 0.0001]
              ]) {
                for (const [dx, dy] of [
                  [
                    [0, 0],
                    [0, 0]
                  ],
                  [
                    [0.5 / 260, 0],
                    [0, 0.5 / 132]
                  ],
                  [
                    [2.7 / 260, 0],
                    [0, 2.7 / 132]
                  ],
                  [
                    [8 / 260, 0],
                    [0, 1 / 132]
                  ],
                  [
                    [7 / 260, 2 / 132],
                    [0.2 / 260, 0.4 / 132]
                  ],
                  [
                    [16 / 260, 0],
                    [0, 16 / 132]
                  ],
                  [
                    [1e5, 0],
                    [0, 1e5]
                  ],
                  [
                    [1e5, 0],
                    [0, 0]
                  ]
                ]) {
                  const lambda = lod(dx, dy, 260, 132, linear, levels);
                  const first = linear ? Math.floor(lambda) : Math.floor(lambda + 0.5);
                  const tail = cold.source.directory.metadata.planes[0].tailFirst;
                  cases.push([
                    ...uv,
                    ...dx,
                    ...dy,
                    refined ? first : Math.max(tail, first),
                    refined
                      ? Math.min(first + 1, levels - 1)
                      : Math.max(tail, Math.min(first + 1, levels - 1)),
                    linear ? lambda % 1 : 0,
                    0,
                    0,
                    0
                  ]);
                }
              }
              const count = cases.length;
              const buffer = (size, usage, data) => {
                const value = device.createBuffer({
                  label: "VT filter oracle",
                  size,
                  usage,
                  mappedAtCreation: !!data
                });
                if (data) {
                  new Float32Array(value.getMappedRange()).set(data);
                  value.unmap();
                }
                buffers.push(value);
                return value;
              };
              const constants = buffer(
                binding.program.constants.length * 4,
                GPUBufferUsage.STORAGE,
                binding.program.constants
              );
              const inputs = buffer(count * 48, GPUBufferUsage.STORAGE, cases.flat());
              const output = buffer(count * 48, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC);
              const readback = buffer(count * 48, GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ);
              const referenceDeclarations = plane.mips
                .map(
                  (_, index) => `@group(3) @binding(${index}) var reference_${index}: texture_2d_array<f32>;`
                )
                .join("\n");
              const referenceSwitch = plane.mips
                .map(
                  (mip, index) => `case ${index}u: {
              let extent = vec2f(${mip.width}.0, ${mip.height}.0);
              return textureSampleGrad(reference_${index}, reference_sampler, (uv * extent + 8.0) / 2304.0, 0,
                dx * extent / 2304.0, dy * extent / 2304.0); }`
                )
                .join("\n");
              const shader = device.createShaderModule({
                label: "VT independent filtering oracle",
                code: `
@group(0) @binding(0) var<storage, read> constants: array<f32>;
@group(0) @binding(1) var<storage, read> inputs: array<vec4f>;
@group(0) @binding(2) var<storage, read_write> output: array<vec4f>;
@group(0) @binding(3) var reference_sampler: sampler;
${referenceDeclarations}
fn native_material_constant(base: u32, slot: u32) -> f32 { return constants[base + slot]; }
${VIRTUAL_TEXTURE_FEEDBACK_WGSL}
${binding.program.source}
fn reference_sample(level: u32, uv: vec2f, dx: vec2f, dy: vec2f) -> vec4f {
  var addressed = clamp(uv, vec2f(0.0), vec2f(1.0)); var direction = vec2f(1.0);
  if ${texture.wrapS}u == 1u { addressed = fract(uv); }
  if ${texture.wrapS}u == 2u {
    let t = uv - floor(uv * 0.5) * 2.0;
    addressed = select(t, 2.0 - t, t > vec2f(1.0));
    direction = select(vec2f(1.0), vec2f(-1.0), t > vec2f(1.0));
  }
  return reference_physical(level, addressed, dx * direction, dy * direction);
}
fn reference_physical(level: u32, uv: vec2f, dx: vec2f, dy: vec2f) -> vec4f {
  switch level { ${referenceSwitch} default: { return vec4f(0.0); } }
}
@compute @workgroup_size(1)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let first = inputs[id.x * 3u]; let second = inputs[id.x * 3u + 1u];
  let uv = first.xy; let dx = first.zw; let dy = second.xy;
  let result = native_material_sample_0(0u, uv, dx, dy);
  let a = reference_sample(u32(second.z), uv, dx, dy);
  let b = reference_sample(u32(second.w), uv, dx, dy);
  output[id.x * 3u] = result;
  output[id.x * 3u + 1u] = mix(a, b, inputs[id.x * 3u + 2u].x);
  let vx = dx * vec2f(260.0, 132.0); let vy = dy * vec2f(260.0, 132.0);
  let pmax = max(dot(vx, vx), dot(vy, vy)); let pmin = min(dot(vx, vx), dot(vy, vy));
  let ratio = min(ceil(pmax / max(pmin, 1e-30)), 64.0);
  output[id.x * 3u + 2u] = vec4f(0.5 * log2(max(pmax / max(ratio, 1.0), 1e-30)), pmax, pmin, ratio);
}`
              });
              const layouts = [
                device.createBindGroupLayout({
                  entries: [
                    ...[0, 1, 2].map((index) => ({
                      binding: index,
                      visibility: GPUShaderStage.COMPUTE,
                      buffer: { type: index === 2 ? "storage" : "read-only-storage" }
                    })),
                    { binding: 3, visibility: GPUShaderStage.COMPUTE, sampler: { type: "filtering" } }
                  ]
                }),
                device.createBindGroupLayout({ entries: binding.layoutEntries }),
                device.createBindGroupLayout({
                  entries: [{ binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } }]
                }),
                device.createBindGroupLayout({
                  entries: plane.mips.map((_, index) => ({
                    binding: index,
                    visibility: GPUShaderStage.COMPUTE,
                    texture: { sampleType: "float", viewDimension: "2d-array" }
                  }))
                })
              ];
              const pipeline = await device.createComputePipelineAsync({
                layout: device.createPipelineLayout({ bindGroupLayouts: layouts }),
                compute: { module: shader, entryPoint: "main" }
              });
              const addressMode = "clamp-to-edge";
              const sampler = graphics.samplers.obtain({
                addressModeU: addressMode,
                addressModeV: addressMode,
                minFilter: linear ? "linear" : "nearest",
                magFilter: linear ? "linear" : "nearest",
                mipmapFilter: linear ? "linear" : "nearest",
                maxAnisotropy: linear ? 8 : 1
              });
              const groups = [
                device.createBindGroup({
                  layout: layouts[0],
                  entries: [
                    ...[constants, inputs, output].map((value, index) => ({
                      binding: index,
                      resource: { buffer: value }
                    })),
                    { binding: 3, resource: sampler }
                  ]
                }),
                device.createBindGroup({ layout: layouts[1], entries: binding.entries }),
                device.createBindGroup({
                  layout: layouts[2],
                  entries: [{ binding: 1, resource: { buffer: vt.feedback.disabled } }]
                }),
                device.createBindGroup({
                  layout: layouts[3],
                  entries: independentMips.map((value, index) => ({
                    binding: index,
                    resource: value.createView({ dimension: "2d-array" })
                  }))
                })
              ];
              const encoder = device.createCommandEncoder(),
                pass = encoder.beginComputePass();
              pass.setPipeline(pipeline);
              groups.forEach((group, index) => pass.setBindGroup(index, group));
              pass.dispatchWorkgroups(count);
              pass.end();
              encoder.copyBufferToBuffer(output, 0, readback, 0, count * 48);
              device.queue.submit([encoder.finish()]);
              await readback.mapAsync(GPUMapMode.READ);
              const values = new Float32Array(readback.getMappedRange());
              let maxError = 0;
              for (let index = 0; index < count; index++)
                for (let channel = 0; channel < (semantic === "occlusion-linear" ? 1 : 3); channel++) {
                  const actual = values[index * 12 + channel],
                    expected = values[index * 12 + 4 + channel];
                  const error = Math.abs(actual - expected);
                  maxError = Math.max(maxError, error);
                  // The reference stores decoded BC texels in rgba16float;
                  // half conversion and normalized atlas coordinates introduce
                  // rounding. The fixed 2/255 bound predates the measurements;
                  // actual maxima are reported without changing the tolerance.
                  check(
                    Number.isFinite(error) && error <= 2 / 255,
                    JSON.stringify({
                      semantic,
                      refined,
                      linear,
                      address: texture.wrapS,
                      index,
                      input: cases[index],
                      actual,
                      expected,
                      error,
                      diagnostic: Array.from(values.slice(index * 12 + 8, index * 12 + 12))
                    })
                  );
                }
              readback.unmap();
              for (const value of independentMips) value.destroy();
              reports.push({ semantic, refined, linear, address: texture.wrapS, count, maxError });
              for (const value of buffers.splice(0)) value.destroy();
            }
        }
        check(cold.preparation.evidence().tiled.retained === 0, "filter lease leak");
      } finally {
        residency.destroy();
        for (const value of textures) value.destroy();
        for (const value of buffers) value.destroy();
      }
    }
    return { ok: true, reports };
  } finally {
    graphics.destroy();
  }
}
