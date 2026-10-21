import { CookedAssetPreparation } from "../../.test-dist/assets/codec/CookedAssetPreparation.js";
import { ImageTextureSource } from "../../.test-dist/assets/ImageTextureSource.js";
import { ImageTextureTranscoder, imageGpuFormat } from "../../.test-dist/gpu/ImageTextureTranscoder.js";
import { imageTextureHash } from "../../.test-dist/assets/ImageTextureProduct.js";
import { LIGHTING_BRDF_TYPES_WGSL, LIGHTING_BRDF_MATH_WGSL } from "../../.test-dist/shaders/lighting_brdf.js";
import { APPEARANCE_NORMAL_FILTER_WGSL } from "../../.test-dist/shaders/appearance_normal_filter.js";
import { encodeMetricValues, MetricStripeEmitter } from "./metric-transport.mjs";

function command(device) {
  const observers = [];
  let submitted = false;
  const gpu_encoder = device.createCommandEncoder();
  return {
    gpu_encoder,
    observeSubmission: (observer) => observers.push(observer),
    async submit() {
      device.queue.submit([gpu_encoder.finish()]);
      submitted = true;
      const fence = device.queue.onSubmittedWorkDone();
      for (const observer of observers) observer.submitted(fence);
      await fence;
    },
    abort(error) {
      if (!submitted) for (const observer of observers) observer.aborted(error);
    }
  };
}

/** Offline only. Each job uses the real shared Worker decoder and production
 * recorder, followed by final BC textureLoad and the unchanged engine BRDF.
 * Never imported by the runtime or used to schedule a visible frame. */
export async function createGpuImageEvaluator(device, identity) {
  const manifest = await (await fetch("/.local/extreme-web-asset/sources.json")).json();
  const shaders = {};
  for (const [variant, name] of Object.entries({
    "bc7-rgb": "spark_bc7_rgb.wgsl",
    "bc7-rgba": "spark_bc7_rgba.wgsl",
    "bc5-rg": "spark_bc5_rg.wgsl",
    "bc4-r": "spark_bc4_r.wgsl",
    utils: "utils.wgsl"
  })) {
    const bytes = new Uint8Array(
      await (await fetch("/.local/extreme-web-asset/sources/spark/src/shaders/" + name)).arrayBuffer()
    );
    if ((await imageTextureHash(bytes)) !== manifest.sources.spark.files["src/shaders/" + name])
      throw new Error("GPU evaluator shader identity mismatch");
    shaders[variant] = new TextDecoder().decode(bytes);
  }
  const transcoder = await ImageTextureTranscoder.create(
    device,
    {
      revision: manifest.sources.spark.revision,
      scope: "local-evaluation",
      shaders
    },
    { precision: "f32" }
  );
  const preparation = new CookedAssetPreparation({ maxWorkers: 1 });
  const errors = [];
  device.lost.then((info) => errors.push(`Device lost: ${info.reason}: ${info.message}`));
  device.addEventListener("uncapturederror", (event) => errors.push(event.error.message));
  const pipelines = new Map();

  async function sample(texture, width, height, semantic, mip, originY, rows) {
    let pipeline = pipelines.get(semantic);
    if (!pipeline) {
      const module = device.createShaderModule({
        code: `
const PI = 3.141592653589793;
const RECIPROCAL_PI = 0.3183098861837907;
const EPSILON = 0.000001;
fn saturate(v: f32) -> f32 { return clamp(v, 0.0, 1.0); }
struct GpuPrimitiveTypeTable { direction: vec3f, color: vec3f, }
${LIGHTING_BRDF_TYPES_WGSL}
${LIGHTING_BRDF_MATH_WGSL}
${APPEARANCE_NORMAL_FILTER_WGSL}
@group(0) @binding(0) var image: texture_2d_array<f32>;
@group(0) @binding(1) var<storage, read_write> output: array<vec4f>;
@group(0) @binding(2) var<uniform> size: vec4u;
@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {
  if id.x >= size.x || id.y >= size.y { return; }
  let value = textureLoad(image, vec2i(id.xy + vec2u(0u, size.w)), 0, i32(size.z));
  let at = (id.y * size.x + id.x) * 7u;
  output[at] = value;
  var normal = vec3f(0.0, 0.0, 1.0);
  ${
    semantic === "normal-xy"
      ? `let xy = value.xy * 2.0 - 1.0;
  normal = normalize(vec3f(xy, sqrt(max(0.0, 1.0 - dot(xy, xy)))));`
      : ""
  }
  ${
    semantic === "moment-xyz"
      ? `let filtered = appearance_decode_normal_moment(value.xyz * 2.0 - 1.0);
  normal = filtered.normal;`
      : ""
  }
  var material: StandardMaterial;
  material.diffuse = ${semantic.startsWith("color-") ? "value.rgb" : semantic === "data-rgb" ? "vec3f(0.5) * (1.0 - value.b)" : "vec3f(0.5)"};
  material.roughness = ${semantic === "data-rgb" ? "max(0.02, value.g)" : semantic === "moment-xyz" ? "max(0.02, filtered.roughness)" : "0.2"};
  material.specularF0 = ${semantic === "data-rgb" ? "mix(vec3f(0.04), vec3f(0.5), value.b)" : "vec3f(0.04)"};
  material.specularF90 = 1.0;
  material.energyCompensation = vec3f(1.0);
  material.coatFactor = 0.0;
  material.coatNormal = normal;
  for (var probe = 0u; probe < 6u; probe++) {
    let phi = f32(probe) * 1.0471975512;
    let light = normalize(vec3f(cos(phi) * 0.8, sin(phi) * 0.8, 0.6));
    let view = normalize(vec3f(0.1, 0.2, 1.0));
    let geometry = SurfaceGeometry(normal, vec3f(0.0, 0.0, 1.0), vec3f(0.0), view);
    let response = prepare_direct_physical(light, geometry, material);
    var reflected = ReflectedLight(vec3f(0.0), vec3f(0.0));
    apply_direct_physical(vec3f(1.0), response, &reflected);
    output[at + probe + 1u] = vec4f((reflected.diffuse + reflected.specular) * ${semantic === "data-rgb" || semantic === "scalar-r" ? "value.r" : "1.0"}, 1.0);
  }
}`
      });
      pipeline = await device.createComputePipelineAsync({
        layout: "auto",
        compute: { module, entryPoint: "main" }
      });
      pipelines.set(semantic, pipeline);
    }
    const bytes = width * rows * 7 * 16;
    if (bytes > device.limits.maxStorageBufferBindingSize || bytes > device.limits.maxBufferSize) {
      throw new Error("GPU evaluation item exceeds readback capacity; tile the offline metric job");
    }
    const output = device.createBuffer({
      size: bytes,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC
    });
    const read = device.createBuffer({
      size: bytes,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
    });
    const size = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    try {
      device.queue.writeBuffer(size, 0, new Uint32Array([width, rows, mip, originY]));
      const encoder = device.createCommandEncoder();
      const pass = encoder.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(
        0,
        device.createBindGroup({
          layout: pipeline.getBindGroupLayout(0),
          entries: [
            {
              binding: 0,
              resource: texture.createView({
                dimension: "2d-array",
                usage: GPUTextureUsage.TEXTURE_BINDING,
                ...(semantic.startsWith("color-") && texture.format === "rgba8unorm"
                  ? { format: "rgba8unorm-srgb" }
                  : {})
              })
            },
            { binding: 1, resource: { buffer: output } },
            { binding: 2, resource: { buffer: size } }
          ]
        })
      );
      pass.dispatchWorkgroups(Math.ceil(width / 8), Math.ceil(rows / 8));
      pass.end();
      encoder.copyBufferToBuffer(output, 0, read, 0, bytes);
      device.queue.submit([encoder.finish()]);
      await read.mapAsync(GPUMapMode.READ);
      return new Float32Array(read.getMappedRange().slice(0));
    } finally {
      read.destroy();
      output.destroy();
      size.destroy();
    }
  }

  return {
    async evaluate(url, hash, length, emit, canonical = false) {
      const source = await ImageTextureSource.open(url, hash, length, undefined, preparation);
      device.pushErrorScope("validation");
      let chunks = 0;
      const transport = new MetricStripeEmitter(emit);
      try {
        for (const item of source.directory.items) {
          const plane = source.directory.planes[item.plane];
          const plan =
            plane.mode === "virtual"
              ? source.pages.page(item.plane, item.mip, Math.floor(item.x / 128), Math.floor(item.y / 128))
              : null;
          // Every VT page is evaluated, not merely each owner's top-left page.
          const pages = plan ? [] : [null];
          if (plan) {
            for (let y = item.y; y < item.y + item.height; y += 128) {
              for (let x = item.x; x < item.x + item.width; x += 128)
                pages.push(source.pages.page(item.plane, item.mip, x / 128, y / 128));
            }
          }
          for (const page of pages) {
            const leases = page ? await source.readPage(page) : await source.read([item.id]);
            const cmd = command(device);
            const count = !page && plane.mips === "runtime" ? source.directory.mipCount : 1;
            const textures = [];
            let width = page ? 144 : item.width,
              height = page ? 144 : item.height;
            for (let mip = 0; mip < count; mip++) {
              textures.push({
                width,
                height,
                texture: device.createTexture({
                  size: [
                    Math.ceil(width / (plane.target === "r8" ? 1 : 4)) * (plane.target === "r8" ? 1 : 4),
                    Math.ceil(height / (plane.target === "r8" ? 1 : 4)) * (plane.target === "r8" ? 1 : 4)
                  ],
                  format: imageGpuFormat(plane.semantic),
                  usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING
                })
              });
              width = Math.max(1, Math.floor(width / 2));
              height = Math.max(1, Math.floor(height / 2));
            }
            try {
              const destinations = textures.map(({ texture }) => ({ texture, mip: 0, layer: 0, x: 0, y: 0 }));
              let logical;
              const inspect = (_encoder, _upload, mips) => {
                logical = mips;
              };
              const status = page
                ? transcoder.recordPage(cmd, leases, page, destinations[0], inspect)
                : plane.target === "r8"
                  ? (transcoder.recordExact(cmd, leases[0], destinations[0]), "recorded")
                  : transcoder.record(cmd, leases[0], destinations, inspect);
              if (status !== "recorded") throw new Error("Serial evaluator cannot fit a single image job");
              await cmd.submit();
              for (let mip = 0; mip < textures.length; mip++) {
                const texture = textures[mip];
                for (let row = 0; row < texture.height; row += 32) {
                  const rows = Math.min(32, texture.height - row);
                  const values = await sample(
                    canonical && logical ? logical[mip] : texture.texture,
                    texture.width,
                    texture.height,
                    plane.semantic,
                    0,
                    row,
                    rows
                  );
                  if (!values.every(Number.isFinite)) throw new Error("Nonfinite final GPU material output");
                  await transport.add({
                    plane: item.plane,
                    mip: page ? item.mip : item.mip + mip,
                    x: page ? page.x * 128 - 8 : item.x,
                    y: (page ? page.y * 128 - 8 : item.y) + row,
                    width: texture.width,
                    height: rows,
                    semantic: plane.semantic,
                    valuesBase64: encodeMetricValues(values)
                  });
                  chunks++;
                }
              }
            } catch (error) {
              cmd.abort(error);
              throw error;
            } finally {
              for (const lease of leases) lease.close();
              for (const { texture } of textures) texture.destroy();
            }
          }
        }
        await transport.flush();
        if (errors.length) throw new Error(errors.join("\n"));
        return { identity, inputHash: hash, representation: "gpu-final-samples", chunks };
      } finally {
        source.close();
        const error = await device.popErrorScope();
        if (error) throw new Error(error.message);
      }
    },
    close() {
      preparation.dispose();
      transcoder.dispose();
    }
  };
}
