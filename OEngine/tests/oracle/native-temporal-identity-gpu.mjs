import {
  nativeTemporalSeedWgsl,
  NATIVE_TEMPORAL_SEED_CLASSIFY_WGSL,
} from "../../.test-dist/shaders/native_temporal_seed.js";
import { packNativeTemporalSeedView } from "../../.test-dist/gpu/FinalPixelAbi.js";
import { nativeSurfaceTemporalMask } from "../../.test-dist/render/temporal/NativeTemporalMath.js";

export async function runNativeTemporalIdentityGpuOracle(device) {
  const current = [
    [4096, 257, 65, 65],
    [2, 257, 65, 65],
    [2, 0, 65, 65],
    [2, 257, 0, 65],
    [2, 257, 65, 2],
    [0x7ffffffe, 0xffffffff, 0x87654321, 0x12345678],
    [2, 257, 65, 65],
    [2, 257, 65, 65],
  ];
  const previous = current.map((value) => [...value]);
  previous[0][0] = 2;
  previous[2][1] = 257;
  previous[3][2] = 65;
  previous[4][3] = 65;
  previous[5][1] = 0xfffffffe;
  const resources = [];
  const texture = (format) => {
    const value = device.createTexture({
      label: `Temporal identity/${format}`,
      size: [8, 1],
      format,
      usage:
        GPUTextureUsage.STORAGE_BINDING |
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_DST |
        GPUTextureUsage.COPY_SRC,
    });
    resources.push(value);
    return value;
  };
  const buffer = (data, usage) => {
    const value = device.createBuffer({ size: data.byteLength, usage, mappedAtCreation: true });
    new Uint8Array(value.getMappedRange()).set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
    value.unmap();
    resources.push(value);
    return value;
  };
  const seed = texture("rgba32float"),
    response = texture("rgba8unorm"),
    identity = texture("rgba32uint");
  const prior = texture("rgba32uint"),
    mask = texture("rgba8unorm");
  device.queue.writeTexture(
    { texture: prior },
    new Uint32Array(previous.flat()),
    { bytesPerRow: 128 },
    [8, 1],
  );
  const matrix = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const view = buffer(
    packNativeTemporalSeedView(8, 1, true, [matrix, matrix, matrix, matrix]),
    GPUBufferUsage.UNIFORM,
  );
  const identities = buffer(new Uint32Array(current.flat()), GPUBufferUsage.STORAGE);
  const writer = device.createShaderModule({
    label: "Temporal identity/production writer",
    code:
      nativeTemporalSeedWgsl(0, 1, 2, 3, false) +
      `
@group(0) @binding(0) var<uniform> view: NativeTemporalSeedView;
@group(0) @binding(4) var<storage, read> identities: array<vec4u>;
fn seed_view() -> NativeTemporalSeedView { return view; }
@compute @workgroup_size(8)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let uv = (vec2f(id.xy) + vec2f(0.5)) / vec2f(8.0, 1.0);
  seed_store(id.xy, vec4f(uv * vec2f(2.0, -2.0) + vec2f(-1.0, 1.0), 0.5, 1.0),
    1.0, 1.0, identities[id.x], true, 0.0, false);
}`,
  });
  const classifier = device.createShaderModule({
    label: "Temporal identity/production classifier",
    code: NATIVE_TEMPORAL_SEED_CLASSIFY_WGSL,
  });
  const staging = device.createBuffer({
    size: 512,
    usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
  });
  resources.push(staging);
  try {
    for (const module of [writer, classifier]) {
      const errors = (await module.getCompilationInfo()).messages.filter(
        (message) => message.type === "error",
      );
      if (errors.length) throw new Error(JSON.stringify(errors));
    }
    const write = await device.createComputePipelineAsync({
      layout: "auto",
      compute: { module: writer, entryPoint: "main" },
    });
    const classify = await device.createComputePipelineAsync({
      layout: "auto",
      compute: { module: classifier, entryPoint: "main" },
    });
    const writeGroup = device.createBindGroup({
      layout: write.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: view } },
        { binding: 1, resource: seed.createView() },
        { binding: 2, resource: response.createView() },
        { binding: 3, resource: identity.createView() },
        { binding: 4, resource: { buffer: identities } },
      ],
    });
    const classifyGroup = device.createBindGroup({
      layout: classify.getBindGroupLayout(0),
      entries: [seed, response, identity, prior, mask].map((value, binding) => ({
        binding,
        resource: value.createView(),
      })),
    });
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(write);
    pass.setBindGroup(0, writeGroup);
    pass.dispatchWorkgroups(1);
    pass.setPipeline(classify);
    pass.setBindGroup(0, classifyGroup);
    pass.dispatchWorkgroups(1);
    pass.end();
    encoder.copyTextureToBuffer({ texture: identity }, { buffer: staging, bytesPerRow: 256 }, [8, 1]);
    encoder.copyTextureToBuffer(
      { texture: mask },
      { buffer: staging, offset: 256, bytesPerRow: 256 },
      [8, 1],
    );
    device.queue.submit([encoder.finish()]);
    await staging.mapAsync(GPUMapMode.READ);
    const mapped = staging.getMappedRange();
    const words = new Uint32Array(mapped, 0, 32);
    const bytes = new Uint8Array(mapped, 256, 32);
    if (words.some((value, i) => value !== current.flat()[i]))
      throw new Error("Temporal writer truncated identity");
    for (let i = 0; i < current.length; i++) {
      const expected = nativeSurfaceTemporalMask(current[i], previous[i], true, true, 0, 0).map((value) =>
        Math.round(value * 255),
      );
      if (expected.some((value, channel) => value !== bytes[i * 4 + channel]))
        throw new Error(`Temporal mask lane ${i} mismatch`);
    }
    staging.unmap();
    return {
      fullWords: true,
      instancesBeyond4094: true,
      materialsBeyond63: true,
      geometryAndMaterialSignatures: true,
      masks: current.length,
    };
  } finally {
    if (staging.mapState === "mapped") staging.unmap();
    resources.forEach((value) => value.destroy());
  }
}
