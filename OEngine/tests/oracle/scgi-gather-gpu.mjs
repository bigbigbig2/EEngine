import assert from "node:assert/strict";
import { Renderer } from "../../.test-dist/render/pipeline/RendererCore.js";
import { Scene } from "../../.test-dist/scene/Scene.js";
import { Mesh } from "../../.test-dist/scene/Mesh.js";
import { BoxGeometry } from "../../.test-dist/geometry/BoxGeometry.js";
import { StandardShadeMaterial } from "../../.test-dist/material/StandardShadeMaterial.js";
import { PerspectiveCamera } from "../../.test-dist/camera/PerspectiveCamera.js";
import { PointLight } from "../../.test-dist/light/PointLight.js";
import { cookSceneGeometryProductV1 } from "../../.test-dist/assets/geometry-product/SceneGeometryCanonicalizerV1.js";
import { createDefaultWebGeometryCookerModule } from "../../.test-dist/assets/web-cook/wasm/WebGeometryCookerAbi.js";
import { ShadeDrawSide } from "../../.test-dist/material/enums.js";
import { decodeFloat16 } from "../../.test-dist/core/Float16.js";
import { SCGI_GATHER_MATH_WGSL } from "../../.test-dist/render/gi/ScgiGatherLayout.js";
import { planScgiGather, scgiGatherPrediction } from "../../.test-dist/render/gi/ScgiGatherLayout.js";
import { scgiGatherWgsl } from "../../.test-dist/shaders/scgi_gather.js";
import { unpackScgiIrradiance } from "../../.test-dist/render/gi/ScgiAbi.js";
import { FinalPixelLightingPublication } from "../../.test-dist/render/lighting/FinalPixelLightingPublication.js";
import { ShadeGPUCommandContext } from "../../.test-dist/framegraph/ShadeGPUCommandContext.js";

async function readBuffer(device, source) {
  const read = device.createBuffer({
    size: source.size,
    usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST
  });
  const encoder = device.createCommandEncoder();
  encoder.copyBufferToBuffer(source, 0, read, 0, source.size);
  device.queue.submit([encoder.finish()]);
  await read.mapAsync(GPUMapMode.READ);
  const bytes = read.getMappedRange().slice(0);
  read.unmap();
  read.destroy();
  return bytes;
}

async function readSource(lab) {
  const source = lab.frame.scgi.gather.source;
  const device = lab.renderer.device;
  const pitch = Math.ceil((source.width * 16) / 256) * 256;
  const read = device.createBuffer({
    size: pitch * source.height,
    usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST
  });
  const encoder = device.createCommandEncoder();
  encoder.copyTextureToBuffer({ texture: source }, { buffer: read, bytesPerRow: pitch }, [
    source.width,
    source.height
  ]);
  device.queue.submit([encoder.finish()]);
  await read.mapAsync(GPUMapMode.READ);
  const padded = new Float32Array(read.getMappedRange());
  const values = new Float32Array(source.width * source.height * 4);
  for (let y = 0; y < source.height; y++)
    values.set(padded.subarray((y * pitch) / 4, (y * pitch) / 4 + source.width * 4), y * source.width * 4);
  read.unmap();
  read.destroy();
  return values;
}

function boxIntersection(origin, direction, box) {
  let near = -Infinity,
    far = Infinity;
  for (let axis = 0; axis < 3; axis++) {
    const low = box.position[axis] - box.size[axis] / 2;
    const high = box.position[axis] + box.size[axis] / 2;
    if (Math.abs(direction[axis]) < 1e-12) {
      if (origin[axis] < low || origin[axis] > high) return Infinity;
    } else {
      const a = (low - origin[axis]) / direction[axis],
        b = (high - origin[axis]) / direction[axis];
      near = Math.max(near, Math.min(a, b));
      far = Math.min(far, Math.max(a, b));
    }
  }
  return far >= Math.max(0, near) ? (near > 1e-5 ? near : far > 1e-5 ? far : Infinity) : Infinity;
}

// Independent analytic boxes + point-light equation. The renderer supplies only
// the published world field; specular/final HDR are never a reference input.
async function checkSource(lab) {
  const source = await readSource(lab);
  const publication = lab.frame.scgi.publication;
  const anchors = new Float32Array(await readBuffer(lab.renderer.device, publication.anchors[0].buffer));
  const field = new Uint32Array(
    await readBuffer(lab.renderer.device, publication.candidateWorldField.segments[0].buffer)
  );
  let checked = 0,
    shadowed = 0,
    lit = 0,
    metallic = 0,
    emissive = 0,
    maximumError = 0;
  for (let pixel = 0; pixel < source.length / 4; pixel++) {
    if (source[pixel * 4 + 3] !== 1 || anchors[pixel * 32 + 3] !== 1) continue;
    const p = [...anchors.subarray(pixel * 32, pixel * 32 + 3)];
    const n = [...anchors.subarray(pixel * 32 + 4, pixel * 32 + 7)];
    const box = lab.referenceBoxes.find((box) => {
      let surface = false;
      for (let axis = 0; axis < 3; axis++) {
        const d = Math.abs(p[axis] - box.position[axis]);
        if (d > box.size[axis] / 2 + 0.0002) return false;
        if (Math.abs(d - box.size[axis] / 2) < 0.0002 && Math.abs(n[axis]) > 0.99) surface = true;
      }
      return surface;
    });
    if (!box) continue;
    const mat = box.material;
    const flag = field[pixel * 28 + 11];
    const c =
      (flag & 3) === 3
        ? unpackScgiIrradiance(field.subarray(pixel * 28, pixel * 28 + 8), 2 ** (((flag >>> 2) & 255) - 126))
        : new Float32Array(12);
    const delta = [lab.light.position.x - p[0], lab.light.position.y - p[1], lab.light.position.z - p[2]];
    const distance = Math.hypot(...delta),
      direction = delta.map((x) => x / distance);
    const origin = p.map((x, axis) => x + n[axis] * 0.0001);
    const blocked = lab.referenceBoxes.some(
      (candidate) => boxIntersection(origin, direction, candidate) < distance - 0.001
    );
    const cosine = Math.max(
      0,
      n.reduce((sum, x, axis) => sum + x * direction[axis], 0)
    );
    const attenuation = Math.max(0, 1 - (distance / 15) ** 4) ** 2 / distance ** 2;
    const direct = blocked ? 0 : lab.light.intensity * attenuation * cosine;
    const diffuse = [mat.diffuse_color.r, mat.diffuse_color.g, mat.diffuse_color.b].map(
      (v) => (v * (1 - mat.metallic_factor)) / Math.PI
    );
    const emission = [mat.emissive_factor.r, mat.emissive_factor.g, mat.emissive_factor.b];
    for (let channel = 0; channel < 3; channel++) {
      const world = Math.max(
        0,
        c[channel] / Math.sqrt(4 * Math.PI) +
          Math.sqrt(3 / (4 * Math.PI)) * n.reduce((sum, x, axis) => sum + x * c[3 + axis * 3 + channel], 0)
      );
      const expected = emission[channel] + diffuse[channel] * (world + direct);
      const error = Math.abs(source[pixel * 4 + channel] - expected);
      maximumError = Math.max(maximumError, error);
      assert.ok(
        error < 0.002 + Math.abs(expected) * 0.002,
        `diffuse source analytic mismatch pixel=${pixel} channel=${channel} actual=${source[pixel * 4 + channel]} expected=${expected}, blocked=${blocked}`
      );
    }
    checked++;
    if (blocked && cosine > 0.1 && mat.metallic_factor === 0) shadowed++;
    if (!blocked && cosine > 0.1 && mat.metallic_factor === 0) lit++;
    if (mat.metallic_factor === 1) metallic++;
    if (mat === lab.emitter) emissive++;
  }
  assert.ok(
    checked > 100 && shadowed > 0 && lit > 0 && metallic > 0 && emissive > 0,
    `source coverage ${JSON.stringify({ checked, shadowed, lit, metallic, emissive })}`
  );
  return { checked, shadowed, lit, metallic, emissive, maximumError };
}

export async function scgiLabReference(lab) {
  const { publication, gather } = lab.frame.scgi;
  const device = lab.renderer.device;
  const words = new Uint32Array(await readBuffer(device, gather.owner.history[gather.owner.role]));
  const probes = new Float32Array(words.buffer);
  const field = new Uint32Array(await readBuffer(device, publication.candidateWorldField.segments[0].buffer));
  const anchors = new Float32Array(await readBuffer(device, publication.anchors[0].buffer));
  const source = await readSource(lab);
  const vp = gather.view.camera.view_projection_matrix;
  const width = publication.halfExtent[0],
    height = publication.halfExtent[1];
  const spp = 8192;
  let beforeSquared = 0,
    afterSquared = 0,
    checked = 0,
    coverage = 0;
  const details = [];
  for (let probe = 0; probe < words.length / 40 && checked < 32; probe++) {
    const at = probe * 40;
    if (!words[at + 39] || probes[at + 19] < 0.02) continue;
    const anchor = words[at + 38],
      f = anchor * 28,
      flags = field[f + 11];
    const c = unpackScgiIrradiance(field.subarray(f, f + 8), 2 ** (((flags >>> 2) & 255) - 126));
    const p = [...probes.subarray(at + 12, at + 15)],
      n = [...probes.subarray(at + 16, at + 19)];
    const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    let tangent = cross(Math.abs(n[2]) > 0.9 ? [0, 1, 0] : [0, 0, 1], n);
    const length = Math.hypot(...tangent);
    tangent = tangent.map((x) => x / length);
    const bitangent = cross(n, tangent);
    const delta = [0, 0, 0];
    let accepted = 0;
    for (let sample = 0; sample < spp; sample++) {
      const z = (sample + 0.5) / spp,
        phi = sample * 2.399963229728653,
        r = Math.sqrt(1 - z * z);
      const direction = n.map(
        (x, axis) => x * z + tangent[axis] * r * Math.cos(phi) + bitangent[axis] * r * Math.sin(phi)
      );
      const origin = p.map((x, axis) => x + n[axis] * 0.00003);
      const distance = Math.min(...lab.referenceBoxes.map((box) => boxIntersection(origin, direction, box)));
      if (!(distance < gather.settings.gatherDistance)) continue;
      const hit = origin.map((x, axis) => x + direction[axis] * distance);
      const clip = [0, 1, 2, 3].map(
        (row) => vp[row] * hit[0] + vp[4 + row] * hit[1] + vp[8 + row] * hit[2] + vp[12 + row]
      );
      if (!(clip[3] > 0)) continue;
      const x = Math.floor((((clip[0] / clip[3]) * 0.5 + 0.5) * publication.extent[0]) / 2);
      const y = Math.floor((((-clip[1] / clip[3]) * 0.5 + 0.5) * publication.extent[1]) / 2);
      if (x < 0 || y < 0 || x >= width || y >= height) continue;
      const index = y * width + x,
        a = index * 32;
      const normal = [...anchors.subarray(a + 4, a + 7)];
      const plane = hit.reduce((sum, value, axis) => sum + (value - anchors[a + axis]) * normal[axis], 0);
      if (source[index * 4 + 3] !== 1 || Math.abs(plane) > 0.002) continue;
      const prediction = scgiGatherPrediction(c, n, direction);
      const t = Math.max(0, Math.min(1, (distance / gather.settings.gatherDistance - 0.75) / 0.25));
      const fade = 1 - t * t * (3 - 2 * t);
      for (let channel = 0; channel < 3; channel++)
        delta[channel] +=
          ((source[index * 4 + channel] - prediction[channel]) * fade * (0.25 + z / 2) * 2 * Math.PI) / spp;
      accepted++;
    }
    const measured = [0, 1, 2].map(
      (channel) =>
        probes[at + channel] / Math.sqrt(4 * Math.PI) +
        Math.sqrt(3 / (4 * Math.PI)) *
          n.reduce((sum, value, axis) => sum + value * probes[at + 3 + axis * 3 + channel], 0)
    );
    for (let channel = 0; channel < 3; channel++) {
      beforeSquared += delta[channel] ** 2;
      afterSquared += (delta[channel] - probes[at + 19] * measured[channel]) ** 2;
    }
    coverage += accepted / spp;
    checked++;
    details.push({ probe, reference: delta, correction: measured, confidence: probes[at + 19] });
  }
  return {
    spp,
    probes: checked,
    coverage: coverage / checked,
    worldOnlyRmse: Math.sqrt(beforeSquared / (checked * 3)),
    withGatherRmse: Math.sqrt(afterSquared / (checked * 3)),
    scope:
      "independent analytic box visibility + published diffuse source; paired near-field L1 target, not full path-traced GI",
    details
  };
}

export async function scgiLabData(lab) {
  const gather = lab.frame.scgi.gather;
  const device = lab.renderer.device;
  const probes = new Uint32Array(await readBuffer(device, gather.owner.history[gather.owner.role]));
  const f = new Float32Array(probes.buffer);
  let valid = 0,
    accepted = 0,
    signed = 0,
    negative = 0,
    confidence = 0;
  for (let at = 0; at < probes.length; at += 40) {
    if (!probes[at + 39]) continue;
    valid++;
    confidence += f[at + 19];
    if (f[at + 19] > 0) accepted++;
    for (let term = 0; term < 12; term++) {
      assert.ok(Number.isFinite(f[at + term]), "signed probe SH must be finite");
      signed += Math.abs(f[at + term]);
      if (f[at + term] < 0) negative++;
    }
  }
  let residualValid = 0,
    residualEnergy = 0;
  for (const source of gather.residual) {
    const bytes = await readBuffer(device, source);
    const u = new Uint32Array(bytes),
      r = new Float32Array(bytes);
    for (let at = 0; at < u.length; at += 8) {
      if (r[at + 7] > 0) residualValid++;
      for (let pair = 0; pair < 6; pair++) {
        const x = decodeFloat16(u[at + pair] & 65535) * r[at + 6];
        const y = decodeFloat16(u[at + pair] >>> 16) * r[at + 6];
        assert.ok(Number.isFinite(x) && Number.isFinite(y), "scaled signed half residual must be finite");
        residualEnergy += Math.abs(x) + Math.abs(y);
      }
    }
  }
  return {
    valid,
    accepted,
    signed,
    negative,
    confidence: confidence / Math.max(1, valid),
    residualValid,
    residualEnergy
  };
}

/** Reusable public-Renderer lab scene: closed room, colored walls, contact
 * blockers, thin partition, metallic control and independently movable emitter. */
export async function createScgiLab(context, width = 160, height = 120, quality = false) {
  let renderer = new Renderer({
    enablePhysicalEnvironment: false,
    enableVsm: false,
    autoExposure: false,
    fixedExposure: 4,
    surfaceCacheGi: {
      enabled: true,
      gather: true,
      resolution: quality ? 8 : 4,
      cascades: 2,
      patches: quality ? 4096 : 512,
      updates: quality ? 256 : 128,
      requests: 2048,
      bounceRequests: 128,
      voxelSize: quality ? 1 : 2,
      hemisphereSamples: quality ? 16 : 8,
      connectionSamples: 2,
      lightSamples: 16,
      batchRays: 128,
      primitiveCapacity: 256,
      queryMaximumBytes: 64 * 1024 ** 2,
      gatherBatchRays: 1024,
      gatherDirections: 64,
      gatherDistance: 3,
      gatherTile: 8
    }
  });
  await renderer.initialize(context ? { context } : {});
  renderer.resize(width, height);
  renderer.temporal_jitter_enabled = false;
  renderer.setScreenSpaceReflectionsSettings({ enabled: false });
  const scene = new Scene();
  const material = (color, emission = [0, 0, 0], metallic = 0) => {
    const value = new StandardShadeMaterial();
    value.diffuse_color.set(...color, 1);
    value.emissive_factor.set(...emission);
    value.metallic_factor = metallic;
    value.draw_side = ShadeDrawSide.Double;
    return value;
  };
  const white = material([0.72, 0.72, 0.72]);
  const red = material([0.8, 0.04, 0.025]);
  const green = material([0.04, 0.65, 0.08]);
  const emitter = material([0, 0, 0], [10, 3, 0.5]);
  const metal = material([0.9, 0.9, 0.9], [0, 0, 0], 1);
  const referenceBoxes = [];
  const box = (size, position, value) => {
    const transform = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, ...position, 1]);
    const mesh = Mesh.from(new BoxGeometry(...size), value, transform);
    scene.add(mesh);
    referenceBoxes.push({ size, position, material: value, mesh });
    return mesh;
  };
  box([6, 0.1, 6], [0, -1.5, 0], white);
  box([6, 0.1, 6], [0, 2.5, 0], white);
  box([0.1, 4, 6], [-3, 0.5, 0], red);
  box([0.1, 4, 6], [3, 0.5, 0], green);
  box([6, 4, 0.1], [0, 0.5, -3], white);
  box([0.9, 1, 0.9], [-1.15, -0.95, -0.7], white);
  box([0.08, 1.5, 1.2], [0.4, -0.7, -0.7], white);
  box([0.7, 0.7, 0.7], [1.5, -1.1, -1.1], metal);
  const movingEmitter = box([0.6, 0.7, 0.08], [-2.4, -0.8, -2.85], emitter);
  const light = new PointLight();
  light.position.set(0, 1.7, 1);
  light.intensity = 8;
  light.distance = 15;
  scene.add(light);
  const camera = new PerspectiveCamera();
  camera.aspect = width / height;
  camera.transform.position.set(0, 0.3, 5.8);
  camera.transform.lookAt({ x: 0, y: -0.3, z: -0.7 });
  camera.update();
  const errors = [];
  renderer.device.addEventListener("uncapturederror", (event) => errors.push(event.error.message));
  let nativeFrame;
  const observeNative = () => {
    const prepare = renderer._surface.prepareFrameNow.bind(renderer._surface);
    renderer._surface.prepareFrameNow = (frame, ...rest) => {
      nativeFrame = frame;
      return prepare(frame, ...rest);
    };
  };
  observeNative();
  const product = await cookSceneGeometryProductV1(scene, {
    module: await createDefaultWebGeometryCookerModule(),
    producerId: "scgi-lab",
    producerVersion: "9",
    maxDecodedProductBytes: 64 * 1024 ** 2
  });
  await renderer.uploadCookedSceneProduct(scene, product);
  const tick = async () => {
    const initial = renderer.frame_count;
    const deadline = performance.now() + 90000;
    while (renderer.frame_count === initial) {
      assert.ok(performance.now() < deadline, "SCGI lab frame must make progress");
      renderer.render(camera, scene);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await renderer.device.queue.onSubmittedWorkDone();
    assert.equal(errors.length, 0, errors.join("\n"));
  };
  return {
    get renderer() {
      return renderer;
    },
    scene,
    camera,
    emitter,
    movingEmitter,
    light,
    tick,
    errors,
    referenceBoxes,
    async recover() {
      renderer.device.destroy();
      await renderer.device.lost;
      renderer = await renderer.recoverAfterDeviceLoss();
      renderer.device.addEventListener("uncapturederror", (event) => errors.push(event.error.message));
      renderer.temporal_jitter_enabled = false;
      observeNative();
    },
    get frame() {
      return nativeFrame;
    }
  };
}

async function checkWindows(lab) {
  const renderer = lab.renderer,
    device = renderer.device;
  const frame = lab.frame,
    original = frame.scgi.lighting;
  const pitch = Math.ceil((frame.width * 8) / 256) * 256;
  const results = [];
  let expected;
  for (const route of ["full", "stripe", "remap"]) {
    const preliminary = new FinalPixelLightingPublication(device);
    const dummy = ShadeGPUCommandContext.create(renderer.graphics, "GraphicsContext/one-shot-maintenance");
    // Extra unused descriptor capacity creates a real remapping pressure while
    // retaining the original local lookup and descriptor meanings verbatim.
    const base = preliminary.prepare(
      original.plan.lookupCount,
      4096,
      dummy,
      undefined,
      [frame.width, frame.height],
      true
    );
    const maximum =
      route === "full"
        ? 128 * 1024 ** 2
        : base.plan.giOffset + (route === "stripe" ? Math.ceil(frame.width / 2) * 144 * 8 : 256);
    dummy.abort();
    preliminary.destroy();
    const projected = new Proxy(device, {
      get(target, key) {
        if (key === "limits")
          return {
            minStorageBufferOffsetAlignment: 256,
            maxBufferSize: 256 * 1024 ** 2,
            maxStorageBufferBindingSize: maximum
          };
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      }
    });
    const directory = new FinalPixelLightingPublication(projected, renderer.graphics);
    const command = ShadeGPUCommandContext.create(renderer.graphics, "GraphicsContext/one-shot-maintenance");
    const view = new Proxy(command, {
      get(target, key) {
        if (key === "device") return projected;
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      }
    });
    const lighting = directory.prepare(
      original.plan.lookupCount,
      4096,
      view,
      undefined,
      [frame.width, frame.height],
      true
    );
    for (const [sourceOffset, targetOffset, bytes] of [
      [0, 0, original.plan.descriptorBytes],
      [original.plan.solarOffset, lighting.plan.solarOffset, original.plan.solarBytes],
      [original.plan.lookupOffset, lighting.plan.lookupOffset, original.plan.lookupBytes]
    ])
      command.copyBufferToBuffer(original.buffer, sourceOffset, lighting.buffer, targetOffset, bytes);
    renderer._surface.prepareFrameNow({
      ...frame,
      lightingEntries: frame.lightingEntries.map((entry) =>
        entry.binding === 2
          ? { binding: 2, resource: { buffer: lighting.nativeBuffer } }
          : entry.binding === 9
            ? { binding: 9, resource: { buffer: lighting.ranges } }
            : entry
      ),
      scgi: { ...frame.scgi, lighting, command }
    });
    renderer._surface.encode(command.gpu_encoder);
    const read = device.createBuffer({
      size: pitch * frame.height,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST
    });
    command.gpu_encoder.copyTextureToBuffer({ texture: frame.output }, { buffer: read, bytesPerRow: pitch }, [
      frame.width,
      frame.height
    ]);
    command.finish();
    renderer._surface.commit(command.gpuDone);
    await command.gpuDone;
    await read.mapAsync(GPUMapMode.READ);
    const bytes = new Uint8Array(read.getMappedRange()).slice();
    read.unmap();
    read.destroy();
    if (!expected) expected = bytes;
    assert.deepEqual(bytes, expected, `Native residual full/stripe/remap differs: ${route}`);
    const windows =
      Math.ceil(frame.width / lighting.plan.windowWidth) * Math.ceil(frame.height / lighting.plan.windowRows);
    assert.equal(lighting.plan.remapped, route === "remap");
    if (route === "stripe") assert.ok(windows > 1);
    results.push({ route, windows, bytes: lighting.nativeBuffer.size });
    directory.destroy();
  }
  return results;
}

// Analytic hemisphere moments are constructed on the CPU; only the actual
// production Gram inverse is executed by the shader. This catches transposes,
// incorrect convolution constants and HDR f32 behavior independently.
async function checkGatherMath(device) {
  const module = device.createShaderModule({
    code: `${SCGI_GATHER_MATH_WGSL}
@group(0) @binding(0) var<storage, read> inputs: array<vec4f>;
@group(0) @binding(1) var<storage, read_write> outputs: array<vec4f>;
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= 18u) { return; }
  let at = id.x * 6u;
  var c: array<vec3f, 4>;
  for (var i = 0u; i < 4u; i++) { c[i] = inputs[at + i].xyz; }
  let p = gather_prediction(c, inputs[at + 4u].xyz, inputs[at + 5u].xyz);
  outputs[id.x] = vec4f(p, 1.0);
}`
  });
  const pipeline = await device.createComputePipelineAsync({
    layout: "auto",
    compute: { module, entryPoint: "main" }
  });
  const inputs = new Float32Array(18 * 24);
  const expected = [];
  for (const n of [
    [0, 0, 1],
    [1, 0, 0],
    [1 / Math.sqrt(3), 1 / Math.sqrt(3), 1 / Math.sqrt(3)]
  ]) {
    for (const L of [0.01, 10, 1e8]) {
      for (const d of [n, [0.3, 0.4, Math.sqrt(0.75)]]) {
        const at = expected.length * 24;
        for (let term = 0; term < 4; term++) {
          const moment = term === 0 ? Math.sqrt(Math.PI) : (Math.sqrt(3 * Math.PI) * n[term - 1]) / 2;
          for (let c = 0; c < 3; c++)
            inputs[at + term * 4 + c] =
              L * [1, 0.5, 0.2][c] * moment * (term === 0 ? Math.PI : (2 * Math.PI) / 3);
        }
        inputs.set(n, at + 16);
        inputs.set(d, at + 20);
        expected.push([L, L / 2, L / 5]);
      }
    }
  }
  const source = device.createBuffer({
    size: inputs.byteLength,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
  });
  const output = device.createBuffer({
    size: 18 * 16,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC
  });
  device.queue.writeBuffer(source, 0, inputs);
  const encoder = device.createCommandEncoder();
  const pass = encoder.beginComputePass();
  pass.setPipeline(pipeline);
  pass.setBindGroup(
    0,
    device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: source } },
        { binding: 1, resource: { buffer: output } }
      ]
    })
  );
  pass.dispatchWorkgroups(1);
  pass.end();
  device.queue.submit([encoder.finish()]);
  const values = new Float32Array(await readBuffer(device, output));
  let maximumRelativeError = 0;
  for (let i = 0; i < expected.length; i++)
    for (let c = 0; c < 3; c++) {
      const error = Math.abs(values[i * 4 + c] - expected[i][c]) / expected[i][c];
      maximumRelativeError = Math.max(maximumRelativeError, error);
      assert.ok(error < 8e-6, `WGSL hemisphere constant/HDR mismatch ${i}/${c}: ${error}`);
    }
  source.destroy();
  output.destroy();
  return { cases: expected.length, maximumRelativeError };
}

async function checkGatherProjection(device) {
  const directions = 256,
    probes = 32,
    count = directions * probes;
  const plan = planScgiGather(device.limits, probes * 8, 8, 8, directions, count);
  const pipeline = await device.createComputePipelineAsync({
    layout: "auto",
    compute: {
      module: device.createShaderModule({ code: scgiGatherWgsl(plan, 0) }),
      entryPoint: "project"
    }
  });
  const settings = new Uint32Array(76);
  settings[7] = count;
  const stats = new Uint32Array(probes * 40);
  for (let i = 0; i < probes; i++) {
    stats[i * 40 + 39] = 1;
    stats[i * 40 + 37] = 0xffffffff;
  }
  // A colored near emitter over a dark contact occluder: 1D angular discontinuity
  // admits exact integrals. Independent 262144-spp spherical integration is also
  // retained, separate from the production hemioctahedral sampling distribution.
  const y0 = 1 / Math.sqrt(4 * Math.PI),
    y1 = Math.sqrt(3 / (4 * Math.PI));
  const reference = [0, 0, 0, 0];
  const spp = 262144;
  for (let i = 0; i < spp; i++) {
    const z = (i + 0.5) / spp;
    const phi = i * 2.399963229728653;
    const r = Math.sqrt(1 - z * z),
      x = r * Math.cos(phi),
      y = r * Math.sin(phi);
    const value = z > 0.6 ? 3 : -1;
    [y0, y1 * x, y1 * y, y1 * z].forEach((sh, term) => {
      reference[term] += ((value * sh * 2 * Math.PI) / spp) * (term === 0 ? Math.PI : (2 * Math.PI) / 3);
    });
  }
  const samples = new Float32Array(count * 8);
  for (let p = 0; p < probes; p++)
    for (let j = 0; j < directions; j++) {
      const u = (j + 0.5) / directions,
        v = (j * 0.6180339887498949 + (p + 0.5) / probes) % 1;
      const raw = [u + v - 1, u - v, 1 - Math.abs(u + v - 1) - Math.abs(u - v)];
      const length = Math.hypot(...raw),
        d = raw.map((x) => x / length);
      const pdf = 0.5 * length ** 3,
        delta = d[2] > 0.6 ? 3 : -1;
      samples.set([delta, delta / 2, delta / 5, 1, ...d, pdf], (p * directions + j) * 8);
    }
  const allocated = [];
  const buffer = (data, uniform = false) => {
    const value = device.createBuffer({
      size: data.byteLength,
      usage:
        (uniform ? GPUBufferUsage.UNIFORM : GPUBufferUsage.STORAGE) |
        GPUBufferUsage.COPY_DST |
        GPUBufferUsage.COPY_SRC
    });
    device.queue.writeBuffer(value, 0, data);
    allocated.push(value);
    return value;
  };
  const params = buffer(settings, true),
    output = buffer(stats),
    previous = buffer(stats),
    input = buffer(samples);
  const run = async () => {
    device.queue.writeBuffer(output, 0, stats);
    const encoder = device.createCommandEncoder(),
      pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(
      0,
      device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: params } },
          { binding: 3, resource: { buffer: output } },
          { binding: 4, resource: { buffer: previous } },
          { binding: 8, resource: { buffer: input } }
        ]
      })
    );
    pass.dispatchWorkgroups(1);
    pass.end();
    device.queue.submit([encoder.finish()]);
    const result = new Float32Array(await readBuffer(device, output));
    return [0, 1, 2, 3].map((term) => {
      let sum = 0;
      for (let i = 0; i < probes; i++) sum += result[i * 40 + term * 3] / probes;
      return sum;
    });
  };
  const projected = await run();
  for (let term = 0; term < 4; term++)
    assert.ok(
      Math.abs(projected[term] - reference[term]) < 0.025,
      `near contact projection vs high-spp term ${term}: ${projected[term]} / ${reference[term]}`
    );
  // 3/4 missing coverage is zero correction, never accepted-count normalization.
  for (let p = 0; p < probes; p++)
    for (let j = 0; j < directions; j++) {
      if (p % 4 !== 0) samples.fill(0, (p * directions + j) * 8, (p * directions + j + 1) * 8);
    }
  device.queue.writeBuffer(input, 0, samples);
  const partial = await run();
  for (let term = 0; term < 4; term++)
    assert.ok(
      Math.abs(partial[term] - reference[term] / 4) < 0.025,
      `partial coverage must retain fixed N, term ${term}`
    );
  for (const resource of allocated) resource.destroy();
  return {
    referenceSpp: spp,
    projectedSpp: count,
    reference,
    projected,
    partial,
    scope: "production SH project kernel; analytic angular contact/color fixture, not whole-room path tracing"
  };
}

async function checkInterpolation(device) {
  const plan = planScgiGather(device.limits, 8, 8, 8, 64, 64);
  const pipeline = await device.createComputePipelineAsync({
    layout: "auto",
    compute: {
      module: device.createShaderModule({ code: scgiGatherWgsl(plan, 0) }),
      entryPoint: "interpolate"
    }
  });
  const settings = new Uint32Array(76),
    sf = new Float32Array(settings.buffer);
  settings.set([8, 8, 4, 4]);
  settings[5] = 16;
  sf.set([3, 0.9, 0.02, 0.1], 52);
  const anchors = new Uint32Array(16 * 32),
    af = new Float32Array(anchors.buffer);
  const field = new Uint32Array(16 * 28),
    probes = new Uint32Array(40),
    pf = new Float32Array(probes.buffer);
  pf[0] = -1e8;
  pf[1] = 2e8;
  pf[2] = -3e8;
  pf[18] = 1;
  pf[19] = 1;
  probes[39] = 1;
  probes.fill(1, 20, 36);
  for (let pixel = 0; pixel < 16; pixel++) {
    af[pixel * 32 + 3] = 1;
    af[pixel * 32 + 6] = 1;
    af[pixel * 32 + 15] = 1;
    anchors.fill(1, pixel * 32 + 16, pixel * 32 + 32);
    field[pixel * 28 + 11] = 3;
  }
  const resources = [];
  const buffer = (data, uniform = false) => {
    const result = device.createBuffer({
      size: data.byteLength,
      usage:
        (uniform ? GPUBufferUsage.UNIFORM : GPUBufferUsage.STORAGE) |
        GPUBufferUsage.COPY_DST |
        GPUBufferUsage.COPY_SRC
    });
    device.queue.writeBuffer(result, 0, data);
    resources.push(result);
    return result;
  };
  const params = buffer(settings, true),
    anchorBuffer = buffer(anchors),
    fields = buffer(field),
    probeBuffer = buffer(probes),
    output = buffer(new Uint32Array(16 * 8));
  const run = async () => {
    device.queue.writeBuffer(anchorBuffer, 0, anchors);
    const encoder = device.createCommandEncoder(),
      pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(
      0,
      device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          [0, params],
          [1, anchorBuffer],
          [2, fields],
          [3, probeBuffer],
          [20, output]
        ].map(([binding, resource]) => ({ binding, resource: { buffer: resource } }))
      })
    );
    pass.dispatchWorkgroups(1);
    pass.end();
    device.queue.submit([encoder.finish()]);
    return new Uint32Array(await readBuffer(device, output));
  };
  const valid = await run(),
    f = new Float32Array(valid.buffer);
  assert.equal(f[7], 1);
  const decoded = decodeFloat16(valid[0] & 65535) * f[6];
  assert.ok(
    decoded < 0 && Math.abs(decoded + 1e8) / 1e8 < 0.001,
    "signed HDR residual must preserve negative energy without overflow"
  );
  for (const mode of ["normal", "plane", "identity"]) {
    const original = anchors.slice();
    for (let pixel = 0; pixel < 16; pixel++) {
      if (mode === "normal") {
        af[pixel * 32 + 6] = 0;
        af[pixel * 32 + 4] = 1;
      }
      if (mode === "plane") af[pixel * 32 + 2] = 1;
      if (mode === "identity") anchors[pixel * 32 + 16] = 2;
    }
    const rejected = await run();
    assert.ok(
      rejected.every((value) => value === 0),
      `incompatible ${mode} must reject residual`
    );
    anchors.set(original);
  }
  for (const resource of resources) resource.destroy();
  return { signedHdr: decoded, rejected: ["normal", "plane", "identity"] };
}

export async function runScgiGatherGpuOracle() {
  const canvas = document.createElement("canvas");
  canvas.width = 160;
  canvas.height = 120;
  document.body.append(canvas);
  const lab = await createScgiLab(canvas.getContext("webgpu"));
  const math = await checkGatherMath(lab.renderer.device);
  const projection = await checkGatherProjection(lab.renderer.device);
  const interpolation = await checkInterpolation(lab.renderer.device);
  window.__SCGI_LAB__ = lab;
  for (let frame = 0; frame < 12; frame++) {
    await lab.tick();
  }
  assert.ok(lab.frame.scgi.gather, "public Renderer must publish gather");
  const data = await scgiLabData(lab);
  const source = await checkSource(lab);
  const reference = await scgiLabReference(lab);
  assert.ok(
    reference.probes > 0 && reference.withGatherRmse < reference.worldOnlyRmse,
    `near-field paired reference must improve with gather: ${JSON.stringify(reference)}`
  );
  const windows = await checkWindows(lab);
  await lab.tick();
  assert.ok(data.valid > 0, "screen probes must spawn on actual world receivers");
  assert.ok(data.accepted > 0, "triangle confirmed source samples must reach probes");
  assert.ok(
    data.residualValid > 0 && data.residualEnergy > 0,
    "previous residual must reach Native next-frame directory"
  );
  const renderer = lab.renderer;
  const noFeedbackOwner = lab.frame.scgi.gather.owner;
  const normalEncode = noFeedbackOwner.encode.bind(noFeedbackOwner);
  let feedbackCopies;
  noFeedbackOwner.encode = (frame, ...rest) => {
    const buffers = [
      frame.transaction.publication.candidateWorld.buffer,
      ...frame.transaction.publication.candidateWorldField.segments.map((segment) => segment.buffer)
    ];
    feedbackCopies = buffers.map((source) => {
      const before = renderer.device.createBuffer({
        size: source.size,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
      });
      const after = renderer.device.createBuffer({
        size: source.size,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
      });
      frame.transaction.command.copyBufferToBuffer(source, 0, before, 0, source.size);
      return { source, before, after };
    });
    normalEncode(frame, ...rest);
    for (const { source, after } of feedbackCopies)
      frame.transaction.command.copyBufferToBuffer(source, 0, after, 0, source.size);
  };
  await lab.tick();
  noFeedbackOwner.encode = normalEncode;
  for (const { before, after } of feedbackCopies) {
    await before.mapAsync(GPUMapMode.READ);
    await after.mapAsync(GPUMapMode.READ);
    assert.deepEqual(
      new Uint8Array(after.getMappedRange()),
      new Uint8Array(before.getMappedRange()),
      "Gather must not write world seed/history/cache"
    );
    before.unmap();
    after.unmap();
    before.destroy();
    after.destroy();
  }
  // Freeze only the screen signal. This must preserve the exact signed probe
  // bytes while the independent world cache continues receiving updates.
  renderer.setSurfaceCacheGiSettings({ gatherFreeze: true });
  await lab.tick();
  const owner = lab.frame.scgi.gather.owner;
  const frozen = new Uint8Array(await readBuffer(renderer.device, owner.history[owner.role]));
  for (let i = 0; i < 4; i++) await lab.tick();
  const afterFreeze = new Uint8Array(await readBuffer(renderer.device, owner.history[owner.role]));
  assert.deepEqual([...afterFreeze], [...frozen], "freeze must not amplify or integrate signed energy");
  renderer.setSurfaceCacheGiSettings({ gatherFreeze: false });
  // Pre-submit failure after the post-Surface producer: committed roles and
  // frame serial must remain unchanged; retry prepares a complete new closure.
  const encode = owner.encode.bind(owner);
  let inject = true;
  owner.encode = (...args) => {
    encode(...args);
    if (inject) {
      inject = false;
      throw new Error("SCGI9 intentional post-gather abort");
    }
  };
  const role = owner.role;
  const frameCount = renderer.frame_count;
  let aborted = false;
  const deadline = performance.now() + 90000;
  while (!aborted) {
    assert.ok(performance.now() < deadline);
    try {
      renderer.render(lab.camera, lab.scene);
    } catch (error) {
      assert.ok(/SCGI9 intentional/.test(error.message), error.message);
      aborted = true;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(owner.role, role, "abort cannot advance screen role");
  assert.equal(renderer.frame_count, frameCount);
  await lab.tick();
  renderer.setSurfaceCacheGiSettings({ gather: false });
  await lab.tick();
  assert.equal(lab.frame.scgi.gather, null);
  assert.ok(lab.frame.scgi.publication.filteredComplete, "world GI remains independent with gather off");
  renderer.setSurfaceCacheGiSettings({ gather: true });
  await lab.tick();
  renderer.setResolutionScale(0.667);
  await lab.tick();
  assert.ok(lab.frame.width < 160 && lab.frame.temporal, "FSR3 consumes the actual lower internal domain");
  renderer.setResolutionScale(1);
  renderer.resize(161, 121);
  await lab.tick();
  assert.deepEqual([...lab.frame.scgi.publication.halfExtent], [81, 61]);
  lab.light.intensity = 4;
  await lab.tick();
  assert.equal(
    lab.frame.scgi.gather.previousValid,
    false,
    "lighting change rejects mismatched prediction history"
  );
  await lab.tick();
  lab.movingEmitter.transform_local.position.x *= -1;
  lab.movingEmitter.updateMatrices();
  await lab.tick();
  assert.equal(lab.frame.scgi.gather.previousValid, false, "moving emitter rejects old source epoch");
  await lab.recover();
  await lab.tick();
  assert.ok(
    lab.frame.scgi.gather && !lab.frame.scgi.gather.previousValid,
    "recovered device starts without stale residual roles"
  );
  await lab.tick();
  return {
    cost: lab.renderer._scgi.cost,
    frames: lab.renderer.frame_count,
    data,
    math,
    projection,
    interpolation,
    source,
    reference,
    windows,
    noWorldFeedback: true,
    movingEmitter: true,
    deviceRecovery: true,
    freeze: true,
    abortRetry: true,
    enableDisable: true,
    nativeFsr3: true,
    oddResize: true,
    lightInvalidation: true
  };
}
