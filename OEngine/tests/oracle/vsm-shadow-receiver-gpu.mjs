import { createNativeSurfaceFixture, identity } from "./native-surface-fixture.mjs";
import { vsmShadowResolveWgsl } from "../../.test-dist/shaders/vsm_shadow_resolve.js";
import { PACKED_CAMERA_TYPE } from "../../.test-dist/shaders/packed_camera.js";
import { FRAME_GEOMETRY_ARENA_VERSION, FRAME_GEOMETRY_ARENA_HEADER_WORDS } from "../../.test-dist/gpu/GpuFrameGeometryArenaAbi.js";

const check = (ok, message) => { if (!ok) throw new Error(message); };

/** Independent analytic planes: the production helper owns reconstruction;
 * the oracle derives the expected normal from the authored plane equation.
 * No VSM residency or neutral PCF can conceal a receiver-normal failure. */
export async function runVsmShadowReceiverGpuOracle(device) {
  const cases = [];
  let assertions = 0, maximumError = 0, depthDerived = 0, geometryDerived = 0;
  for (const { slopes, perspective, scale } of [
    { slopes: [0, 0], perspective: 0, scale: [1, 1, 1] },
    { slopes: [.18, -.11], perspective: 0, scale: [1, 1, 1] },
    { slopes: [.14, .1], perspective: .2, scale: [1, 1, 1] },
    { slopes: [.14, .1], perspective: .2, scale: [-1, 1, 1] },
  ]) {
    const width = 64, height = 32;
    const fixture = await createNativeSurfaceFixture(device, { width, height, planeSlopes: slopes, perspective, scale });
    const readback = device.createBuffer({ size: width * height * 16,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    try {
      const cameraWords = new Float32Array(PACKED_CAMERA_TYPE.size / 4);
      for (const field of PACKED_CAMERA_TYPE.fields) {
        if (field.type.size !== 64) continue;
        const matrix = [...identity];
        if (field.name.includes("projection")) matrix[3] = field.name.includes("inverse") ? -perspective : perspective;
        cameraWords.set(matrix, field.offset / 4);
      }
      const camera = fixture.uniform(cameraWords, "Receiver oracle/inverse VP");
      const settings = new Uint32Array(16), floats = new Float32Array(settings.buffer);
      settings.set(fixture.geometry.source, 0);
      settings.set(fixture.geometry.sourcePayload, 4);
      settings.set([width, height, 0, fixture.generation], 8);
      floats.set([0, 0, 3, 0], 12);
      const uniform = fixture.uniform(settings, "Receiver oracle/settings");
      const output = fixture.makeTexture(width, height, "rgba32float",
        GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC);
      const module = device.createShaderModule({ code: vsmShadowResolveWgsl(false, false) + `
@group(0) @binding(9) var receiver_oracle_output: texture_storage_2d<rgba32float, write>;
@compute @workgroup_size(8,8)
fn receiver_probe(@builtin(global_invocation_id) id: vec3u) {
  if (any(id.xy >= settings.dimensions.xy)) { return; }
  let receiver = shadow_receiver(id.xy);
  var result = vec4f(0.0, 0.0, 0.0, -1.0);
  if (receiver.valid) { result = vec4f(receiver.normal, f32(u32(receiver.depth_derived))); }
  textureStore(receiver_oracle_output, vec2i(id.xy), result);
}` });
      const info = await module.getCompilationInfo();
      check(!info.messages.some(m => m.type === "error"), JSON.stringify(info.messages));
      const pipeline = await device.createComputePipelineAsync({ layout: "auto", compute: { module, entryPoint: "receiver_probe" } });
      const group = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [
        { binding: 0, resource: { buffer: uniform } },
        { binding: 1, resource: { buffer: fixture.geometry.meshletWork } },
        { binding: 2, resource: { buffer: fixture.geometry.arena } },
        { binding: 3, resource: { buffer: fixture.geometry.vertexPayload } },
        { binding: 4, resource: { buffer: fixture.geometry.instances } },
        { binding: 5, resource: fixture.visibility.createView() },
        { binding: 6, resource: fixture.depth.createView() },
        { binding: 8, resource: { buffer: camera } },
        { binding: 9, resource: output.createView() },
      ] });
      const depthModule = device.createShaderModule({ code: `
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  let p = array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3));
  return vec4f(p[i],0,1);
}
@fragment fn fs(@builtin(position) p: vec4f) -> @builtin(frag_depth) f32 {
  let ndc = p.xy / vec2f(${width}.0,${height}.0) * vec2f(2,-2) + vec2f(-1,1);
  let denominator = 1.0 - ${perspective.toFixed(8)} * ndc.x;
  let world = ndc / denominator;
  let z = (0.5 + ${slopes[0].toFixed(8)} * world.x / ${scale[0]}.0 +
    ${slopes[1].toFixed(8)} * world.y / ${scale[1]}.0) * ${scale[2]}.0;
  return clamp(z * denominator, 0.0, 1.0);
}` });
      const depthPipeline = await device.createRenderPipelineAsync({ layout: "auto",
        vertex: { module: depthModule, entryPoint: "vs" }, fragment: { module: depthModule, entryPoint: "fs", targets: [] },
        depthStencil: { format: "depth32float", depthWriteEnabled: true, depthCompare: "always" } });
      const normal = [-slopes[0] * scale[2] / scale[0], -slopes[1] * scale[2] / scale[1], 1];
      const length = Math.hypot(...normal), expected = normal.map(v => v / length);
      for (const route of ["same-winner-depth", "complete-source", "isolated-winners"]) {
        const keys = new Uint32Array(width * height).fill(0xffffffff);
        for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
          if (route === "isolated-winners" && ((x & 1) === 0 || (y & 1) === 0)) continue;
          const nx = (x + .5) / width * 2 - 1, ny = 1 - (y + .5) / height * 2;
          const denominator = 1 - perspective * nx;
          const ox = nx / denominator / scale[0], oy = ny / denominator / scale[1];
          if (Math.abs(ox) >= 1 || Math.abs(oy) >= 1) continue;
          const gx = (ox + 1) * width / 2, gy = (1 - oy) * height / 2;
          const slot = Math.floor(gx / 8) + Math.floor(gy / 8) * (width / 8);
          const primitive = gx % 8 + gy % 8 > 8 ? 1 : 0;
          keys[y * width + x] = (slot | primitive << 24) >>> 0;
        }
        // A missing filtered directory aliases the source directory; its high
        // selector bit does not force a miss. Remove only the optional cache
        // header version, retaining all immutable source records and identities.
        device.queue.writeBuffer(fixture.geometry.arena,
          (fixture.geometry.sourcePayload[3] + FRAME_GEOMETRY_ARENA_HEADER_WORDS.version) * 4,
          new Uint32Array([route === "complete-source" ? 0 : FRAME_GEOMETRY_ARENA_VERSION]));
        device.queue.writeBuffer(uniform, 0, settings);
        device.queue.writeTexture({ texture: fixture.visibility }, keys, { bytesPerRow: width * 4 }, [width, height]);
        const encoder = device.createCommandEncoder();
        const raster = encoder.beginRenderPass({ colorAttachments: [], depthStencilAttachment: {
          view: fixture.depth.createView(), depthLoadOp: "clear", depthClearValue: 0, depthStoreOp: "store" } });
        raster.setPipeline(depthPipeline); raster.draw(3); raster.end();
        const pass = encoder.beginComputePass();
        pass.setPipeline(pipeline); pass.setBindGroup(0, group); pass.dispatchWorkgroups(width / 8, height / 8); pass.end();
        encoder.copyTextureToBuffer({ texture: output }, { buffer: readback, bytesPerRow: width * 16 }, [width, height]);
        device.queue.submit([encoder.finish()]);
        await readback.mapAsync(GPUMapMode.READ);
        const values = new Float32Array(readback.getMappedRange());
        let fast = 0, source = 0;
        for (let pixel = 0; pixel < keys.length; pixel++) {
          if (keys[pixel] === 0xffffffff) {
            check(values[pixel * 4 + 3] === -1, `Background receiver ${pixel}`); assertions++; continue;
          }
          check(values[pixel * 4 + 3] >= 0, `Lost winner ${pixel}/${route}`); assertions++;
          for (let axis = 0; axis < 3; axis++) {
            const error = Math.abs(values[pixel * 4 + axis] - expected[axis]);
            check(error <= 2e-4, `Plane normal ${route}/${slopes}/${perspective}/${scale}/${pixel}/${axis}: ${error}`);
            maximumError = Math.max(maximumError, error); assertions++;
          }
          if (values[pixel * 4 + 3] === 1) fast++; else source++;
        }
        readback.unmap();
        if (route === "same-winner-depth") check(fast > 0 && source > 0, "Both reconstruction domains must execute");
        else check(fast === 0 && source > 0, "Isolated/source winners must retain full geometry");
        depthDerived += fast; geometryDerived += source;
        cases.push({ slopes, perspective, scale, route, fast, source });
      }
    } finally {
      await device.queue.onSubmittedWorkDone(); readback.destroy(); fixture.destroy();
    }
  }
  return { passed: true, assertions, maximumError, depthDerived, geometryDerived, cases,
    contract: "camera-facing geometry face; complete winner key; independent analytic plane; tolerance frozen 2e-4" };
}
