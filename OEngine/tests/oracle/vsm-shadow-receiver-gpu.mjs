import { createNativeSurfaceFixture, identity } from "./native-surface-fixture.mjs";
import { vsmShadowResolveWgsl } from "./reference/s3/vsm_shadow_resolve.mjs";
import { PACKED_CAMERA_TYPE } from "../../.test-dist/shaders/packed_camera.js";
import { FRAME_GEOMETRY_ARENA_VERSION, FRAME_GEOMETRY_ARENA_HEADER_WORDS } from "../../.test-dist/gpu/GpuFrameGeometryArenaAbi.js";
import { nativeSurfaceWgsl } from "../../.test-dist/shaders/native_surface.js";
import { AppearanceGraphBuilder } from "../../.test-dist/material/AppearanceGraph.js";
import { compileAppearanceGraph } from "../../.test-dist/material/AppearanceGraphCompiler.js";
import { lowerNativeMaterial } from "../../.test-dist/shaders/native_material.js";

const check = (ok, message) => { if (!ok) throw new Error(message); };

/** Independent analytic planes: the production helper owns reconstruction;
 * the oracle derives the expected normal from the authored plane equation.
 * No VSM residency or neutral PCF can conceal a receiver-normal failure. */
async function runReceiver(device, native) {
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
      const settings = new Uint32Array(native ? 52 : 16), floats = new Float32Array(settings.buffer);
      settings.set(fixture.geometry.source, 0);
      settings.set(fixture.geometry.sourcePayload, 4);
      settings.set([width, height, 0, fixture.generation], 8);
      floats.set([0, 0, 3, 0], 12);
      if (native) {
        floats.set(identity, 16);
        const inverse = [...identity]; inverse[3] = -perspective;
        floats.set(inverse, 36);
      }
      const uniform = fixture.uniform(settings, "Receiver oracle/settings");
      const output = fixture.makeTexture(width, height, "rgba32float",
        GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC);
      const builder = new AppearanceGraphBuilder();
      builder.output("baseColor", builder.constant([1, 1, 1]));
      const program = lowerNativeMaterial(compileAppearanceGraph(builder.build()));
      const production = native
        ? nativeSurfaceWgsl(program, { compact: false, productGeometry: false, unlit: false, reactive: false }) + `
fn shadow_receiver(pixel: vec2u) -> vec4f {
  let key = textureLoad(visibility, vec2i(pixel), 0).r;
  let decoded = oengine_visibility_key_resolve(key, meshlet_work.header.generation, meshlet_work.header.written_count);
  if (decoded.valid == 0u) { return vec4f(0.0, 0.0, 0.0, -1.0); }
  let work = meshlet_work.elements[decoded.meshlet_work_slot];
  let origin = (vec2f(pixel) + vec2f(0.5)) / vec2f(settings.dimensions.xy) * vec2f(2.0, -2.0) + vec2f(-1.0, 1.0);
  let resolved = geometry_complete_resolved(decoded, work, frame_instances[work.instance_slot]);
  let interpolation = winner_interpolate(resolved.coefficients, vec2f(pixel) + vec2f(0.5), vec2f(settings.dimensions.xy));
  if ((interpolation.flags & WINNER_VALUE_VALID) == 0u) { return vec4f(0.0, 0.0, 0.0, -1.0); }
  let position = native_resolved_position(resolved, pixel);
  return vec4f(native_face_normal(resolved.world_plane.xyz, position), 0.0);
}`
        : vsmShadowResolveWgsl(false, false);
      const module = device.createShaderModule({ code: production + `
@group(0) @binding(9) var receiver_oracle_output: texture_storage_2d<rgba32float, write>;
@compute @workgroup_size(8,8)
fn receiver_probe(@builtin(global_invocation_id) id: vec3u) {
  if (any(id.xy >= settings.dimensions.xy)) { return; }
  let receiver = shadow_receiver(id.xy);
  var result = vec4f(0.0, 0.0, 0.0, -1.0);
  ${native ? "result = receiver;" : "if (receiver.valid) { result = vec4f(receiver.normal, f32(u32(receiver.depth_derived))); }"}
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
        ...(!native ? [
          { binding: 6, resource: fixture.depth.createView() },
          { binding: 8, resource: { buffer: camera } },
        ] : []),
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
        if (!native && route === "same-winner-depth") check(fast > 0 && source > 0, "Both reconstruction domains must execute");
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

// Independent f64 linear systems constrain projected XY and the authored plane.
// The golden never executes the production inverse-VP/clip-Z solve.
function solveLinear(rows, rhs) {
  const a = rows.map((row, i) => [...row, rhs[i]]);
  for (let col = 0; col < rows.length; col++) {
    let pivot = col;
    for (let row = col + 1; row < rows.length; row++) {
      if (Math.abs(a[row][col]) > Math.abs(a[pivot][col])) pivot = row;
    }
    check(Math.abs(a[pivot][col]) > 1e-14, "Position golden singular system");
    [a[col], a[pivot]] = [a[pivot], a[col]];
    const divisor = a[col][col];
    a[col] = a[col].map(value => value / divisor);
    for (let row = 0; row < rows.length; row++) {
      if (row === col) continue;
      const factor = a[row][col];
      a[row] = a[row].map((value, i) => value - factor * a[col][i]);
    }
  }
  return a.map(row => row[rows.length]);
}

async function runPositionProbes(device) {
  const near = 0.1, far = 100;
  const matrices = [
    { name: "finite-reverse-perspective", rows: [[1.3,0,0,0],[0,1.7,0,0],[0,0,near/(far-near),near*far/(far-near)],[0,0,-1,0]] },
    { name: "infinite-far-perspective", rows: [[1.3,0,0,0],[0,1.7,0,0],[0,0,0,near],[0,0,-1,0]] },
    { name: "orthographic", rows: [[0.4,0,0,-0.1],[0,0.5,0,0.2],[0,0,1/(far-near),far/(far-near)],[0,0,0,1]] },
  ];
  const builder = new AppearanceGraphBuilder();
  builder.output("baseColor", builder.constant([1,1,1]));
  const program = lowerNativeMaterial(compileAppearanceGraph(builder.build()));
  const source = nativeSurfaceWgsl(program, { compact: false, productGeometry: false, unlit: true, reactive: false });
  const module = device.createShaderModule({ label: "Position oracle/actual Native helper", code: source + `
struct PositionProbe {
  plane: vec4f,
  p0: vec4f,
  p1: vec4f,
  p2: vec4f,
  clip0: vec4f,
  clip1: vec4f,
  clip2: vec4f,
}
@group(0) @binding(20) var<uniform> probe: PositionProbe;
@group(0) @binding(21) var<storage, read_write> positions: array<vec4f>;
@compute @workgroup_size(8,8)
fn position_probe(@builtin(global_invocation_id) id: vec3u) {
  var resolved: GeometryResolved;
  resolved.world_plane = probe.plane;
  resolved.position = GeometryCorners(probe.p0, probe.p1, probe.p2);
  resolved.coefficients = winner_build_coefficients(probe.clip0, probe.clip1, probe.clip2);
  positions[id.x + id.y * 16u] = vec4f(native_resolved_position(resolved, id.xy), 1.0);
}` });
  const info = await module.getCompilationInfo();
  check(!info.messages.some(message => message.type === "error"), JSON.stringify(info.messages));
  const pipeline = await device.createComputePipelineAsync({ label: "Position oracle/probe", layout: "auto", compute: { module, entryPoint: "position_probe" } });
  const buffers = [];
  const buffer = (label, size, usage) => {
    const result = device.createBuffer({ label, size, usage });
    buffers.push(result); return result;
  };
  const settings = buffer("Position oracle/settings", 208, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
  const probe = buffer("Position oracle/plane and corners", 112, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
  const output = buffer("Position oracle/output", 16*8*16, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC);
  const readback = buffer("Position oracle/readback", output.size, GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST);
  const group = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [
    { binding: 0, resource: { buffer: settings } },
    { binding: 20, resource: { buffer: probe } },
    { binding: 21, resource: { buffer: output } },
  ] });
  const results = [];
  try {
    for (const matrix of matrices) {
      const inverse = [0,1,2,3].flatMap(col => solveLinear(matrix.rows, [0,1,2,3].map(row => Number(row === col))));
      const words = new Float32Array(52);
      new Uint32Array(words.buffer).set([16,8,0,1],8); words.set(inverse,36);
      const plane = [0.2,-0.1,1,3];
      const corners = [[-10,-10], [10,-10], [0,10]].map(([x,y]) => [x,y,-3-0.2*x+0.1*y,1]);
      const clips = corners.map(point => matrix.rows.map(row => row.reduce((sum, value, i) => sum + value * point[i], 0)));
      for (const fallback of [false,true]) {
        device.queue.writeBuffer(settings,0,words);
        device.queue.writeBuffer(probe,0,new Float32Array([...(fallback ? [0,0,0,0] : plane), ...corners.flat(), ...clips.flat()]));
        const encoder = device.createCommandEncoder({ label: "Position oracle/dispatch" });
        const pass = encoder.beginComputePass(); pass.setPipeline(pipeline); pass.setBindGroup(0,group); pass.dispatchWorkgroups(2,1); pass.end();
        encoder.copyBufferToBuffer(output,0,readback,0,output.size); device.queue.submit([encoder.finish()]);
        await readback.mapAsync(GPUMapMode.READ);
        const values = new Float32Array(readback.getMappedRange());
        let maximumError = 0;
        for (let y=0;y<8;y++) for (let x=0;x<16;x++) {
          const ndc = [(x+0.5)/16*2-1,1-(y+0.5)/8*2];
          const rows = [matrix.rows[0].map((value,i) => value-ndc[0]*matrix.rows[3][i]),
            matrix.rows[1].map((value,i) => value-ndc[1]*matrix.rows[3][i]),plane,[0,0,0,1]];
          const expected = solveLinear(rows,[0,0,0,1]);
          for (let axis=0;axis<3;axis++) {
            const actual = values[(x+y*16)*4+axis];
            const error = Math.abs(actual-expected[axis]);
            check(Number.isFinite(actual) && error <= 2e-4, `${matrix.name}/${fallback}/${x}/${y}/${axis}: ${error}`);
            maximumError = Math.max(maximumError,error);
          }
        }
        readback.unmap(); results.push({ name: matrix.name, fallback, maximumError, pixels: 128 });
      }
    }
  } finally {
    await device.queue.onSubmittedWorkDone();
    for (const resource of buffers) resource.destroy();
  }
  return results;
}

export async function runVsmShadowReceiverGpuOracle(device) {
  const reference = await runReceiver(device, false);
  const native = await runReceiver(device, true);
  const positionProbes = await runPositionProbes(device);
  return { reference, native, positionProbes, contract: "Frozen S3 and actual Native staged face against the same analytic planes; no depth reconstruction in Native" };
}
