import { createNativeSurfaceFixture, identity } from "./native-surface-fixture.mjs";
import { nativeSurfaceWgsl } from "../../.test-dist/shaders/native_surface.js";
import { AppearanceGraphBuilder } from "../../.test-dist/material/AppearanceGraph.js";
import { compileAppearanceGraph } from "../../.test-dist/material/AppearanceGraphCompiler.js";
import { lowerNativeMaterial } from "../../.test-dist/shaders/native_material.js";
import { PACKED_CAMERA_TYPE } from "../../.test-dist/shaders/packed_camera.js";

const check = (value, message) => { if (!value) throw new Error(message); };

/** Adversarial, independently specified page-discontinuous depth atlas. Full
 * 1080p domain and every page boundary remain in the metric; no boundary
 * exclusion. The golden is the authored plane equation and resident checker
 * depth, never a call to production reconstruction or PCF. Frozen S3 supplies
 * the quality envelope, but cannot determine the Native production graph.
 * Constant slot depth means all point taps including gutters have the same
 * comparison; separate sampling oracles cover nonconstant tap multiplicity. */
export async function runFinalPixelShadowQualityGpuOracle(device) {
  const width = 1920, height = 1080, frames = 256;
  const cases = [
    { name: "flat-page-boundary", slopes: [0, 0], perspective: 0, scale: [1, 1, 1] },
    { name: "slope-moving-sun", slopes: [0.18, -0.11], perspective: 0, scale: [1, 1, 1] },
    { name: "perspective", slopes: [0.14, 0.1], perspective: 0.2, scale: [1, 1, 1] },
    { name: "mirrored", slopes: [0.14, 0.1], perspective: 0.2, scale: [-1, 1, 1] },
  ];
  const results = [];
  for (const spec of cases) {
    const fixture = await createNativeSurfaceFixture(device, { width, height, planeSlopes: spec.slopes,
      perspective: spec.perspective, scale: spec.scale });
    const retained = [];
    try {
      const settings = new Uint32Array(52), floats = new Float32Array(settings.buffer);
      settings.set(fixture.geometry.source); settings.set(fixture.geometry.sourcePayload, 4);
      settings.set([width, height, 0, fixture.generation], 8);
      floats.set([0, 0, 3, 1], 12); floats.set(identity, 16);
      const inverse = [...identity]; inverse[3] = -spec.perspective;
      floats.set(inverse, 36);
      const view = fixture.uniform(settings, "Shadow quality/Native settings");
      const cameraWords = new Float32Array(PACKED_CAMERA_TYPE.size / 4);
      for (const field of PACKED_CAMERA_TYPE.fields) {
        if (field.type.size !== 64) continue;
        const matrix = [...identity];
        if (field.name.includes("projection")) matrix[3] = field.name.includes("inverse") ? -spec.perspective : spec.perspective;
        cameraWords.set(matrix, field.offset / 4);
      }
      const camera = fixture.uniform(cameraWords, "Shadow quality/S3 camera");
      const sunWords = new Float32Array(16);
      sunWords.set([0, 0.6, 0.8, 0.001, 1, 1, 1, 1, 1]);
      const sun = fixture.uniform(sunWords, "Shadow quality/Sun");
      const vsmWords = new Float32Array(64);
      vsmWords.set(identity);
      vsmWords.set([-1, -1, 2, 0], 16);
      new Uint32Array(vsmWords.buffer).set([16, 128, 2, 16, 1, fixture.generation, 4, 2112], 40);
      vsmWords.set([0.3, 0.5, 0.1, 1], 48);
      vsmWords.set([-8, 8, 1 / 16, 1], 52);
      new Uint32Array(vsmWords.buffer).set([fixture.generation, 1, 0, 0], 56);
      const builder = new AppearanceGraphBuilder();
      builder.output("baseColor", builder.constant([1, 1, 1]));
      const program = lowerNativeMaterial(compileAppearanceGraph(builder.build()));
      const columns = Math.ceil(width / 8), rows = Math.ceil(height / 8), tiles = columns * rows;
      const output = fixture.storage(tiles * 64, "Shadow quality/full-domain metrics");
      const readback = device.createBuffer({ label: "Shadow quality/metrics readback", size: output.size,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
      retained.push(readback);
      const module = device.createShaderModule({ label: "Shadow quality/actual Native receiver",
        code: nativeSurfaceWgsl(program, { compact: false, productGeometry: false, unlit: false,
          reactive: false, physicalSun: true }) + `
@group(0) @binding(20) var s3_shadow: texture_2d<u32>;
@group(0) @binding(21) var<storage, read_write> metrics: array<vec4f>;
var<workgroup> errors: array<vec4f, 64>;
var<workgroup> boundary_errors: array<vec4f, 64>;
var<workgroup> energy: array<vec4f, 64>;
var<workgroup> maxima: array<vec4f, 64>;
@compute @workgroup_size(8, 8)
fn quality(@builtin(global_invocation_id) id: vec3u, @builtin(workgroup_id) group: vec3u,
  @builtin(local_invocation_index) lane: u32) {
  errors[lane] = vec4f(0.0); boundary_errors[lane] = vec4f(0.0);
  energy[lane] = vec4f(0.0); maxima[lane] = vec4f(0.0);
  let pixel = id.xy;
  if (all(pixel < settings.dimensions.xy)) {
    let key = textureLoad(visibility, vec2i(pixel), 0).r;
    let decoded = oengine_visibility_key_resolve(key, meshlet_work.header.generation, meshlet_work.header.written_count);
    if (decoded.valid != 0u) {
      let work = meshlet_work.elements[decoded.meshlet_work_slot];
      let origin = (vec2f(pixel) + vec2f(0.5)) / vec2f(settings.dimensions.xy) * vec2f(2.0, -2.0) + vec2f(-1.0, 1.0);
      let resolved = geometry_complete_resolved(decoded, work, frame_instances[work.instance_slot]);
      let interpolation = winner_interpolate(resolved.coefficients, vec2f(pixel) + vec2f(0.5), vec2f(settings.dimensions.xy));
      let position = native_resolved_position(resolved, pixel);
      let face = native_face_normal(resolved.world_plane.xyz, position);
      var incident: GpuPrimitiveTypeTable;
      incident.direction = normalize(native_physical_sun.sun_direction_world); incident.color = vec3f(1.0);
      let actual = vsm_sample_directional(position, face, incident);
      let packed = textureLoad(s3_shadow, vec2i(vec2u(pixel.x / 4u, pixel.y)), 0).r;
      let byte = (packed >> ((pixel.x % 4u) * 8u)) & 255u;
      let axis = 1u + ((byte >> 5u) & 3u);
      let reference = f32(byte & 31u) / f32(axis * axis);
      // Independent plane + exact projection inverse. No geometry helper.
      let ndc = (vec2f(pixel) + vec2f(0.5)) / vec2f(settings.dimensions.xy) * vec2f(2.0, -2.0) + vec2f(-1.0, 1.0);
      let world_xy = ndc / (1.0 - ${spec.perspective} * ndc.x);
      let world_z = (0.5 + ${spec.slopes[0]} * world_xy.x / ${spec.scale[0]}.0 + ${spec.slopes[1]} * world_xy.y / ${spec.scale[1]}.0) * ${spec.scale[2]}.0;
      let golden_position = vec3f(world_xy, world_z);
      let light_xy = world_xy + vsm_constants.light_view[3].xy;
      let page = vec2i(floor(light_xy * 8.0));
      let inside = all(page >= vec2i(-8)) && all(page < vec2i(8));
      let golden = select(1.0, select(0.0, 1.0, ((page.x + page.y + 32) & 1) == 0), inside);
      let difference = vec2f(actual - golden, reference - golden);
      errors[lane] = vec4f(difference * difference, 1.0, golden * golden);
      let fraction = fract(light_xy * 8.0);
      let distance = min(fraction, vec2f(1.0) - fraction);
      if (any(distance <= vec2f(16.0 / f32(settings.dimensions.x), 16.0 / f32(settings.dimensions.y)))) {
        boundary_errors[lane] = errors[lane];
      }
      energy[lane] = vec4f(actual, reference, golden, 1.0);
      let golden_face = normalize(vec3f(${-spec.slopes[0] * spec.scale[2] / spec.scale[0]}, ${-spec.slopes[1] * spec.scale[2] / spec.scale[1]}, 1.0));
      maxima[lane] = vec4f(abs(difference), max(max(abs(position.x - golden_position.x), abs(position.y - golden_position.y)), abs(position.z - golden_position.z)),
        max(max(abs(face.x - golden_face.x), abs(face.y - golden_face.y)), abs(face.z - golden_face.z)));
    }
  }
  workgroupBarrier();
  for (var stride = 32u; stride > 0u; stride /= 2u) {
    if (lane < stride) {
      errors[lane] += errors[lane + stride]; boundary_errors[lane] += boundary_errors[lane + stride];
      energy[lane] += energy[lane + stride]; maxima[lane] = max(maxima[lane], maxima[lane + stride]);
    }
    workgroupBarrier();
  }
  if (lane == 0u) {
    let at = (group.x + group.y * ${columns}u) * 4u;
    metrics[at] = errors[0]; metrics[at + 1u] = boundary_errors[0];
    metrics[at + 2u] = energy[0]; metrics[at + 3u] = maxima[0];
  }
}` });
      const compilation = await module.getCompilationInfo();
      check(!compilation.messages.some(m => m.type === "error"), JSON.stringify(compilation.messages));
      const pipeline = await device.createComputePipelineAsync({ label: "Shadow quality/probe", layout: "auto",
        compute: { module, entryPoint: "quality" } });
      const groups = [device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [
        { binding: 0, resource: { buffer: view } },
        ...[fixture.geometry.meshletWork, fixture.geometry.arena, fixture.geometry.vertexPayload, fixture.geometry.instances]
          .map((buffer, i) => ({ binding: i + 1, resource: { buffer } })),
        { binding: 5, resource: fixture.visibility.createView() },
        { binding: 20, resource: fixture.vsm.shadowVisibility.createView() },
        { binding: 21, resource: { buffer: output } },
      ] }), device.createBindGroup({ layout: pipeline.getBindGroupLayout(1), entries: [
        ...fixture.lightingEntries.filter(entry => [2, 8, 9, 10, 16].includes(entry.binding)),
        { binding: 12, resource: { buffer: sun } },
      ] })];
      const keys = new Uint32Array(width * height).fill(0xffffffff);
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        const ndcX = (x + 0.5) / width * 2 - 1, ndcY = 1 - (y + 0.5) / height * 2;
        const denominator = 1 - spec.perspective * ndcX;
        const ox = ndcX / denominator / spec.scale[0], oy = ndcY / denominator / spec.scale[1];
        if (Math.abs(ox) >= 1 || Math.abs(oy) >= 1) continue;
        const gx = (ox + 1) * width / 2, gy = (1 - oy) * height / 2;
        keys[y * width + x] = (Math.floor(gx / 8) + Math.floor(gy / 8) * (width / 8)) | ((gx % 8 + gy % 8 > 8 ? 1 : 0) << 24);
      }
      device.queue.writeTexture({ texture: fixture.visibility }, keys, { bytesPerRow: width * 4 }, [width, height]);
      const depthModule = device.createShaderModule({ code: `
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  let p = array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3)); return vec4f(p[i],0,1);
}
@fragment fn fs(@builtin(position) p: vec4f) -> @builtin(frag_depth) f32 {
  let ndc = p.xy / vec2f(${width}.0,${height}.0) * vec2f(2,-2) + vec2f(-1,1);
  let denominator = 1.0 - ${spec.perspective} * ndc.x;
  let world = ndc / denominator;
  let z = (0.5 + ${spec.slopes[0]} * world.x / ${spec.scale[0]}.0 + ${spec.slopes[1]} * world.y / ${spec.scale[1]}.0) * ${spec.scale[2]}.0;
  return clamp(z * denominator, 0.0, 1.0);
}` });
      const depthPipeline = await device.createRenderPipelineAsync({ layout: "auto", vertex: { module: depthModule, entryPoint: "vs" },
        fragment: { module: depthModule, entryPoint: "fs", targets: [] },
        depthStencil: { format: "depth32float", depthWriteEnabled: true, depthCompare: "always" } });
      const depthEncoder = device.createCommandEncoder();
      const raster = depthEncoder.beginRenderPass({ colorAttachments: [], depthStencilAttachment: {
        view: fixture.depth.createView(), depthLoadOp: "clear", depthClearValue: 0, depthStoreOp: "store" } });
      raster.setPipeline(depthPipeline); raster.draw(3); raster.end(); device.queue.submit([depthEncoder.finish()]);
      const frameRows = [];
      for (let frame = 0; frame < frames; frame++) {
        const motion = frame < 64 ? 0 : Math.min(frame - 64, 127);
        vsmWords[12] = motion * 0.25 * 2 / width;
        vsmWords[13] = motion * 0.125 * 2 / height;
        sunWords[0] = motion * 0.002;
        device.queue.writeBuffer(fixture.vsm.constants, 0, vsmWords);
        device.queue.writeBuffer(sun, 0, sunWords);
        const encoder = device.createCommandEncoder({ label: `Shadow quality/${spec.name}/${frame}` });
        const referenceCommand = {
          writeBuffer: (...args) => device.queue.writeBuffer(...args),
          copyBufferToBuffer: (...args) => encoder.copyBufferToBuffer(...args),
          beginComputePass: (...args) => encoder.beginComputePass(...args),
        };
        fixture.vsm.shadowResolve.encode(referenceCommand, { width, height, cameraPosition: [0, 0, 3], geometry: fixture.geometry,
          visibility: fixture.visibility, depth: fixture.depth, camera, constants: fixture.vsm.constants,
          descriptors: fixture.vsm.descriptors, atlas: fixture.vsm.atlas.createView(), sun, output: fixture.vsm.shadowVisibility });
        const pass = encoder.beginComputePass(); pass.setPipeline(pipeline);
        groups.forEach((group, i) => pass.setBindGroup(i, group));
        pass.dispatchWorkgroups(columns, rows); pass.end();
        encoder.copyBufferToBuffer(output, 0, readback, 0, output.size);
        device.queue.submit([encoder.finish()]); await readback.mapAsync(GPUMapMode.READ);
        const values = new Float32Array(readback.getMappedRange());
        const sums = new Float64Array(12), maximum = new Float64Array(4);
        for (let tile = 0; tile < tiles; tile++) {
          for (let lane = 0; lane < 12; lane++) sums[lane] += values[tile * 16 + lane];
          for (let lane = 0; lane < 4; lane++) maximum[lane] = Math.max(maximum[lane], values[tile * 16 + 12 + lane]);
        }
        readback.unmap();
        const row = { frame, validPixels: sums[2], boundaryPixels: sums[6],
          rmse: Math.sqrt(sums[0] / Math.max(sums[3], 1e-20)), referenceRmse: Math.sqrt(sums[1] / Math.max(sums[3], 1e-20)),
          boundaryRmse: Math.sqrt(sums[4] / Math.max(sums[7], 1e-20)), referenceBoundaryRmse: Math.sqrt(sums[5] / Math.max(sums[7], 1e-20)),
          energyError: Math.abs(sums[8] - sums[10]), referenceEnergyError: Math.abs(sums[9] - sums[10]),
          peak: maximum[0], referencePeak: maximum[1], positionError: maximum[2], normalError: maximum[3] };
        frameRows.push(row);
        check(row.validPixels > width * height * 0.8, `${spec.name}/${frame}: incomplete full domain`);
        check(row.positionError <= 2e-4 && row.normalError <= 2e-4, `${spec.name}/${frame}: receiver arithmetic ${JSON.stringify(row)}`);
        check(row.rmse <= row.referenceRmse + 2 ** -10 && row.boundaryRmse <= row.referenceBoundaryRmse + 2 ** -10,
          `${spec.name}/${frame}: shadow quality ${JSON.stringify(row)}`);
        check(row.peak <= row.referencePeak && row.energyError <= row.referenceEnergyError,
          `${spec.name}/${frame}: peak/energy ${JSON.stringify(row)}`);
      }
      results.push({ ...spec, frameRows });
    } finally {
      await device.queue.onSubmittedWorkDone();
      retained.forEach(resource => resource.destroy()); fixture.destroy();
    }
  }
  return { width, height, frames, warmup: 64, movement: [64, 191], stop: [192, 255], results,
    limitations: ["Receiver/Sun visibility submatrix with adversarial analytic page discontinuities; full material HDR and MASK are separate production/integration oracles", "No full Renderer visual acceptance or performance claim"] };
}
