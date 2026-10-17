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
import {
  AppearanceGraphBuilder,
  snapshotAppearanceTexture,
} from "../../.test-dist/material/AppearanceGraph.js";
import { decodeFloat16, encodeFloat16 } from "../../.test-dist/core/Float16.js";
import { FinalPixelLightingPublication } from "../../.test-dist/render/lighting/FinalPixelLightingPublication.js";
import { ShadeGPUCommandContext } from "../../.test-dist/framegraph/ShadeGPUCommandContext.js";
import { ShadeTexture } from "../../.test-dist/texture/ShadeTexture.js";
import { ShadeTransparencyMode } from "../../.test-dist/material/enums.js";
import { sourceFixture } from "./streaming-vt-gpu.mjs";
import { fixtureTexture } from "./texture-fixture.mjs";
import { nativeSurfaceBindingGroups } from "../../.test-dist/shaders/native_surface.js";

/** Exact public Renderer/config/upload/render entry. No alternate GI producer. */
export async function runScgiProductionGpuOracle(options = {}) {
  const adapter = await navigator.gpu.requestAdapter({
    powerPreference: "high-performance",
    featureLevel: "core",
  });
  const requiredFeatures = [
    "core-features-and-limits",
    "indirect-first-instance",
    "texture-formats-tier1",
    "texture-compression-bc",
  ];
  for (const feature of ["primitive-index", "subgroups", "timestamp-query"]) {
    if (adapter.features.has(feature)) requiredFeatures.push(feature);
  }
  const limitedDevice = await adapter.requestDevice({
    requiredFeatures,
    requiredLimits: {
      maxStorageBuffersPerShaderStage: 16,
      maxStorageBufferBindingSize: 128 * 1024 ** 2,
      maxBufferSize: 256 * 1024 ** 2,
      maxSampledTexturesPerShaderStage: 16,
      maxStorageTexturesPerShaderStage: adapter.limits.maxStorageTexturesPerShaderStage,
    },
  });
  const context = new OffscreenCanvas(65, 49).getContext("webgpu");
  let renderer = new Renderer({
    enablePhysicalEnvironment: true,
    enableVsm: true,
    autoExposure: false,
    surfaceCacheGi: {
      enabled: true,
      gather: options.gather === true,
      // The enclosure is 12 units wide. This matrix needs actual screen hits
      // on both the enclosure and the small VT/custom receivers.
      gatherDistance: 20,
      gatherTile: 4,
      gatherDirections: 64,
      gatherBatchRays: 1024,
      resolution: 4,
      cascades: 2,
      patches: 128,
      updates: 64,
      requests: 1024,
      bounceRequests: 64,
      voxelSize: 4,
      hemisphereSamples: 2,
      connectionSamples: 1,
      lightSamples: 4,
      batchRays: 64,
      primitiveCapacity: 32,
      queryMaximumBytes: 32 * 1024 ** 2,
    },
  });
  await renderer.initialize({ adapter, device: limitedDevice, context });
  renderer.resize(65, 49);
  renderer.temporal_jitter_enabled = false;
  let device = renderer.device;
  const errors = [];
  device.addEventListener("uncapturederror", (event) => errors.push(event.error.message));
  let scene = new Scene();
  const materials = Array.from({ length: 4 }, () => new StandardShadeMaterial());
  const tiled = await sourceFixture();
  materials[0].texture_occlusion = ShadeTexture.fromTiled(tiled.source);
  materials[0].transparency_mode = ShadeTransparencyMode.AlphaTested;
  materials[1].clearcoat_factor = 0.5;
  materials[2].is_unlit = true;
  const meshes = [];
  const graphBuilder = new AppearanceGraphBuilder();
  const uv = graphBuilder.input("uv0", 2, "surface", undefined, "uv0");
  let baseColor = graphBuilder.constant([0, 0, 0]);
  for (let index = 0; index < 8; index++) {
    const size = (index + 1) * 4;
    const texture = await fixtureTexture(
      "base-color-srgb",
      Array.from({ length: Math.floor(Math.log2(size)) + 1 }, (_, level) => {
        const extent = Math.max(1, size >> level);
        return {
          logicalWidth: extent,
          logicalHeight: extent,
          payload: Uint8Array.from({ length: extent * extent * 4 }, (_, lane) => (lane % 4 === 3 ? 255 : 96)),
        };
      }),
    );
    baseColor = graphBuilder.operation(
      "add",
      baseColor,
      graphBuilder.swizzle(
        graphBuilder.texture(snapshotAppearanceTexture(texture, "srgb-rgb"), uv),
        [0, 1, 2],
      ),
    );
  }
  for (const filter of [0, 1]) {
    const texture = ShadeTexture.fromTiled(tiled.source);
    texture.minFilter = texture.magFilter = filter;
    baseColor = graphBuilder.operation(
      "add",
      baseColor,
      graphBuilder.swizzle(
        graphBuilder.texture(snapshotAppearanceTexture(texture, "linear-rgb"), uv),
        [0, 0, 0],
      ),
    );
  }
  const viewDirection = graphBuilder.input("viewDirection", 3, "view");
  graphBuilder.output(
    "baseColor",
    graphBuilder.operation(
      "add",
      graphBuilder.operation("divide", baseColor, graphBuilder.constant(10)),
      graphBuilder.operation(
        "multiply",
        graphBuilder.operation("abs", viewDirection),
        graphBuilder.constant(0.1),
      ),
    ),
  );
  graphBuilder.output("alpha", graphBuilder.constant(1));
  for (const [name, value] of Object.entries({
    metallic: 0,
    roughness: 0.5,
    occlusion: 1,
    emissive: [0, 0, 0],
    normalTS: [0, 0, 1],
    ior: 1.5,
    specularWeight: 1,
    specularColor: [1, 1, 1],
    coatWeight: 0,
    coatRoughness: 0.2,
    coatNormalTS: [0, 0, 1],
  })) {
    graphBuilder.output(name, graphBuilder.constant(value));
  }
  materials[3].appearance_definition = { schemaVersion: 1, graph: graphBuilder.build() };
  materials.forEach((material, index) => {
    const matrix = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, (index - 1.5) * 0.8, 0, 0, 1]);
    const mesh = Mesh.from(new BoxGeometry(0.65, 0.65, 0.65), material, matrix);
    meshes.push(mesh);
    scene.add(mesh);
  });
  if (options.gather === true) {
    const partition = Mesh.from(new BoxGeometry(0.035, 1.2, 0.6), materials[1]);
    partition.transform_local.position.set(0.5, 0.15, 0.7);
    partition.updateMatrices();
    scene.add(partition);
  }
  // An enclosing emissive surface makes indirect transport nonzero even with
  // no authored environment; the assertion below reads the actual field.
  const enclosure = new StandardShadeMaterial();
  enclosure.draw_side = ShadeDrawSide.Double;
  enclosure.emissive_factor.set(0.7, 0.3, 0.1);
  scene.add(Mesh.from(new BoxGeometry(12, 12, 12), enclosure));
  const light = new PointLight();
  light.position.set(0, 2, 3);
  light.intensity = 5;
  scene.add(light);
  const camera = new PerspectiveCamera();
  camera.aspect = 65 / 49;
  camera.transform.position.set(0, 0, 4);
  camera.transform.lookAt({ x: 0, y: 0, z: 0 });
  camera.update();
  let nativeFrame;
  let giFrame;
  let capture = false;
  let injectedAbort = false;
  let injectNotification = false;
  let records;
  let localOverflowRead;
  const prepareNative = renderer._surface.prepareFrameNow.bind(renderer._surface);
  renderer._surface.prepareFrameNow = (input, ...rest) => {
    nativeFrame = input;
    if (input.scgi) {
      giFrame = input.scgi;
      if (injectNotification) {
        injectNotification = false;
        giFrame.command.onFinished.addOne(() => {
          throw new Error("SCGI8 intentional submitted notification");
        });
      }
    }
    return prepareNative(input, ...rest);
  };
  // A direct source-consumer fixture requests every valid anchor. Natural
  // query demand is verified separately in scgi-gather; this input ensures
  // VT/custom/coat/Unlit all exercise the same real Native material invocation.
  const allSources =
    options.gather !== true
      ? null
      : await device.createComputePipelineAsync({
          layout: "auto",
          compute: {
            entryPoint: "main",
            module: device.createShaderModule({
              code: `
struct Anchor {
  position: vec4f, normal: vec3f, source: u32,
  previous: vec4f, motion: vec4f, identity: array<u32, 16>,
}
struct Offsets { requests: u32, ids: u32, count: u32, capacity: u32, }
@group(0) @binding(0) var<uniform> offsets: Offsets;
@group(0) @binding(1) var<storage, read> anchors: array<Anchor>;
@group(0) @binding(2) var<storage, read_write> work: array<atomic<u32>>;
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= offsets.count) { return; }
  atomicStore(&work[offsets.requests + id.x * 2u], 0u);
  if (anchors[id.x].position.w != 1.0) { return; }
  let ticket = atomicAdd(&work[0u], 1u);
  if (ticket >= offsets.capacity) { atomicStore(&work[2u], 1u); return; }
  atomicStore(&work[offsets.ids + ticket], id.x);
  atomicStore(&work[offsets.requests + id.x * 2u], ticket + 1u);
  atomicStore(&work[offsets.requests + id.x * 2u + 1u], anchors[id.x].source + 1u);
}
`,
            }),
          },
        });
  let fixtureRequests = false;
  const encodeNative = renderer._surface.encode.bind(renderer._surface);
  renderer._surface.encode = (encoder) => {
    if (capture && allSources !== null && !fixtureRequests) {
      fixtureRequests = true;
      const gather = giFrame.gather;
      const plan = gather.owner.plan.work;
      const parameters = giFrame.command.allocateTransientBufferAndLoad(
        new Uint32Array([
          plan.requests,
          plan.ids,
          gather.owner.plan.halfWidth * gather.owner.plan.halfHeight,
          plan.capacity,
        ]).buffer,
      );
      encoder.clearBuffer(gather.owner.work, 0, 16);
      const pass = encoder.beginComputePass({ label: "Oracle/request all exact material sources" });
      pass.setPipeline(allSources);
      pass.setBindGroup(
        0,
        device.createBindGroup({
          layout: allSources.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: { buffer: parameters } },
            { binding: 1, resource: { buffer: giFrame.publication.anchors[0].buffer } },
            { binding: 2, resource: { buffer: gather.owner.work } },
          ],
        }),
      );
      pass.dispatchWorkgroups(Math.ceil((gather.owner.plan.halfWidth * gather.owner.plan.halfHeight) / 64));
      pass.end();
    }
    encodeNative(encoder);
    if (injectedAbort) {
      injectedAbort = false;
      throw new Error("SCGI8 intentional pre-submit abort");
    }
    if (localOverflowRead) {
      encoder.copyBufferToBuffer(localOverflowRead.source, 0, localOverflowRead.buffer, 0, 128);
    }
    if (capture) {
      const { width, height } = nativeFrame;
      const pitch = Math.ceil((width * 8) / 256) * 256;
      const hdr = device.createBuffer({
        size: pitch * height,
        usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
      });
      encoder.copyTextureToBuffer({ texture: nativeFrame.output }, { buffer: hdr, bytesPerRow: pitch }, [
        width,
        height,
      ]);
      const field = giFrame.publication.candidateWorldField.segments.map((segment) => {
        const buffer = device.createBuffer({
          size: segment.buffer.size,
          usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
        });
        encoder.copyBufferToBuffer(segment.buffer, 0, buffer, 0, buffer.size);
        return { buffer, range: segment.plan.ranges.worldField };
      });
      const diagnostics = [
        giFrame.publication.candidateWorld.buffer,
        giFrame.publication.privateScratch.buffer,
        ...giFrame.publication.anchors.map((anchor) => anchor.buffer),
        renderer._scgi.scenes.frameReadable(giFrame.command).coverageStatus,
      ].map((source) => {
        const buffer = device.createBuffer({
          size: source.size,
          usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
        });
        encoder.copyBufferToBuffer(source, 0, buffer, 0, source.size);
        return buffer;
      });
      records = {
        source:
          options.gather !== true
            ? null
            : (() => {
                const source = giFrame.gather.owner.work;
                const buffer = device.createBuffer({
                  size: source.size,
                  usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
                });
                encoder.copyBufferToBuffer(source, 0, buffer, 0, source.size);
                return { buffer, plan: giFrame.gather.owner.plan.work };
              })(),
        hdr,
        field,
        pitch,
        width,
        height,
        plan: giFrame.lighting.plan,
        diagnostics,
        allocation: renderer._scgi.estimator.plan,
      };
    }
  };
  try {
    const product = await cookSceneGeometryProductV1(scene, {
      module: await createDefaultWebGeometryCookerModule(),
      producerId: "scgi-production-oracle",
      producerVersion: "8",
      maxDecodedProductBytes: 32 * 1024 ** 2,
    });
    await renderer.uploadCookedSceneProduct(scene, product);
    const tick = async () => {
      const initial = renderer.frame_count;
      const deadline = performance.now() + 60_000;
      while (renderer.frame_count === initial) {
        assert.ok(performance.now() < deadline, "SCGI production frame must make progress");
        renderer.render(camera, scene);
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      await device.queue.onSubmittedWorkDone();
    };
    for (let warm = 0; warm < 8; warm++) await tick();
    capture = true;
    await tick();
    const read = async () => {
      const value = records;
      await value.hdr.mapAsync(GPUMapMode.READ);
      const half = new Uint16Array(value.hdr.getMappedRange());
      const rgb = [];
      for (let y = 0; y < value.height; y++) {
        for (let x = 0; x < value.width; x++) {
          for (let channel = 0; channel < 3; channel++) {
            const color = decodeFloat16(half[(y * value.pitch) / 2 + x * 4 + channel]);
            assert.ok(Number.isFinite(color), "Native GI-lit HDR must be finite");
            rgb.push(color);
          }
        }
      }
      value.hdr.unmap();
      value.hdr.destroy();
      let valid = 0;
      let positive = 0;
      for (const item of value.field) {
        await item.buffer.mapAsync(GPUMapMode.READ);
        const words = new Uint32Array(item.buffer.getMappedRange());
        for (let pixel = 0; pixel < item.range.count; pixel++) {
          const at = item.range.offset / 4 + pixel * 28;
          if ((words[at + 11] & 3) === 3) {
            valid++;
            if ((words[at] & 0xffff) !== 0) positive++;
          }
        }
        item.buffer.unmap();
        item.buffer.destroy();
      }
      const diagnostics = [];
      for (const buffer of value.diagnostics) {
        await buffer.mapAsync(GPUMapMode.READ);
        diagnostics.push(new Uint32Array(buffer.getMappedRange()).slice());
        buffer.unmap();
        buffer.destroy();
      }
      const layout = value.allocation;
      assert.ok(
        valid > 0 && positive > 0,
        `Production transport/filter must publish positive guided irradiance: valid=${valid}, positive=${positive}, header=${Array.from(diagnostics[0].slice(0, 64))}, control=${Array.from(diagnostics[1].slice(layout.scratch.ranges.cacheControl.offset / 4, layout.scratch.ranges.cacheControl.offset / 4 + 32))}, anchors=${Array.from(diagnostics[2].slice(0, 32))},coverage=${Array.from(diagnostics.at(-1).slice(0, 12))}`,
      );
      let source = null;
      if (value.source !== null) {
        await value.source.buffer.mapAsync(GPUMapMode.READ);
        const words = new Uint32Array(value.source.buffer.getMappedRange());
        const plan = value.source.plan;
        const count = words[0];
        assert.equal(words[2], 0);
        assert.ok(count > 0, "material matrix must have real requested source work");
        source = {
          count,
          prepared: 0,
          qualified: 0,
          missing: 0,
          preparation: Array.from(words.subarray(plan.preparation, plan.preparation + count * 12)),
          visibility: { checked: 0, maximumError: 0, meanAbsoluteError: 0 },
        };
        // Every receiver is inside the closed 12-unit enclosure. An infinite
        // solar ray must meet its six exact box planes, including receivers
        // around the added thin partition. PCF is compared as an approximation.
        const anchors = new Float32Array(diagnostics[2].buffer);
        for (let ticket = 0; ticket < count; ticket++) {
          const at = plan.preparation + ticket * 12;
          assert.equal(
            words[at + 7],
            0x3f800000,
            "each exact requested pixel must run its real Native graph",
          );
          source.prepared++;
          const visibility = new Float32Array(words.buffer)[at + 11];
          if (visibility >= 0) {
            source.qualified++;
            const index = words[plan.ids + ticket];
            const position = anchors.subarray(index * 32, index * 32 + 3);
            if (position.every((value) => Math.abs(value) < 5.99)) {
              source.visibility.checked++;
              source.visibility.maximumError = Math.max(source.visibility.maximumError, visibility);
              source.visibility.meanAbsoluteError += visibility;
            }
          } else source.missing++;
        }
        source.visibility.meanAbsoluteError /= Math.max(1, source.visibility.checked);
        assert.ok(source.visibility.checked > 0 || source.qualified === 0);
        value.source.buffer.unmap();
        value.source.buffer.destroy();
      }
      return {
        source,
        rgb,
        valid,
        positive,
        remapped: value.plan.remapped,
        windows:
          Math.ceil(value.width / value.plan.windowWidth) * Math.ceil(value.height / value.plan.windowRows),
      };
    };
    const full = await read();
    capture = false;
    const sourceFrame = nativeFrame;
    const sourceGi = giFrame;
    const windowResults = [];
    // Force real coarse fallback while retaining the actual atlas/page slots.
    // Only the publication input is perturbed; both paths use the same Native
    // decoder, gather, filtering and material shaders.
    const originalDirectory = sourceGi.lighting;
    const descriptorRead = device.createBuffer({
      size: originalDirectory.plan.descriptorBytes,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });
    const sourceConstants = sourceFrame.lightingEntries.find((entry) => entry.binding === 8).resource;
    const constantRead = device.createBuffer({
      size: 256,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });
    const inspect = device.createCommandEncoder();
    inspect.copyBufferToBuffer(originalDirectory.buffer, 0, descriptorRead, 0, descriptorRead.size);
    inspect.copyBufferToBuffer(sourceConstants.buffer, sourceConstants.offset ?? 0, constantRead, 0, 256);
    device.queue.submit([inspect.finish()]);
    await descriptorRead.mapAsync(GPUMapMode.READ);
    const coarseDescriptors = new Uint32Array(descriptorRead.getMappedRange()).slice();
    descriptorRead.unmap();
    descriptorRead.destroy();
    await constantRead.mapAsync(GPUMapMode.READ);
    const samplingWords = new Uint32Array(constantRead.getMappedRange()).slice();
    constantRead.unmap();
    constantRead.destroy();
    let coarsePages = 0;
    for (let at = 0; at < coarseDescriptors.length; at += 4) {
      if (coarseDescriptors[at + 2] === 0) coarseDescriptors[at + 2] = 2;
      if (coarseDescriptors[at + 2] === 1) coarsePages++;
    }
    assert.ok(coarsePages > 0, "Actual VSM publication must contain ready coarse pages");
    const modifiedConstants = device.createBuffer({
      size: 256,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    const exposureBuffer = device.createBuffer({
      size: 4,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
    });
    const missingDescriptors = coarseDescriptors.slice();
    for (let at = 0; at < missingDescriptors.length; at += 4) missingDescriptors[at + 2] = 2;
    const cases = [
      { name: "actual", mode: null },
      { name: "exposure-2", mode: null, exposure: 2 },
      { name: "exposure-quarter", mode: null, exposure: 0.25 },
      ...[0, 1, 2].map((mode) => ({ name: `coarse-${mode}`, mode })),
      ...(options.gather === true ? [{ name: "missing-pages", mode: 0, missing: true }] : []),
    ];
    for (const sampleCase of cases) {
      let expected =
        sampleCase.exposure === undefined
          ? full.rgb
          : full.rgb.map((value) => decodeFloat16(encodeFloat16(value * sampleCase.exposure)));
      for (const route of sampleCase.exposure !== undefined
        ? ["remap"]
        : sampleCase.mode === null
          ? ["stripe", "remap"]
          : ["full", "remap"]) {
        const remap = route === "remap";
        const projected = new Proxy(device, {
          get(target, key) {
            if (key === "limits")
              return {
                minStorageBufferOffsetAlignment: 256,
                maxBufferSize: 256 * 1024 ** 2,
                maxStorageBufferBindingSize:
                  route === "full"
                    ? 128 * 1024 ** 2
                    : sourceGi.lighting.plan.giOffset + (remap ? 256 : 80 * 1024),
              };
            const value = Reflect.get(target, key, target);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
        const directory = new FinalPixelLightingPublication(projected, renderer.graphics);
        const command = ShadeGPUCommandContext.create(
          renderer.graphics,
          "GraphicsContext/one-shot-maintenance",
        );
        const commandView = new Proxy(command, {
          get(target, key) {
            if (key === "device") return projected;
            const value = Reflect.get(target, key, target);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
        const original = sourceGi.lighting;
        const lighting = directory.prepare(
          original.plan.lookupCount,
          original.plan.descriptorCount,
          commandView,
          original.plan.filterNoiseBytes === 0 ? undefined : renderer._vsmFilterData,
          [65, 49],
          options.gather === true,
        );
        command.copyBufferToBuffer(original.buffer, 0, lighting.buffer, 0, original.plan.descriptorBytes);
        command.copyBufferToBuffer(
          original.buffer,
          original.plan.solarOffset,
          lighting.buffer,
          lighting.plan.solarOffset,
          original.plan.solarBytes,
        );
        command.copyBufferToBuffer(
          original.buffer,
          original.plan.lookupOffset,
          lighting.buffer,
          lighting.plan.lookupOffset,
          original.plan.lookupBytes,
        );
        if (original.plan.filterNoiseBytes !== 0) {
          command.copyBufferToBuffer(
            original.buffer,
            original.plan.filterNoiseOffset,
            lighting.buffer,
            lighting.plan.filterNoiseOffset,
            original.plan.filterNoiseBytes,
          );
        }
        if (sampleCase.mode !== null) {
          command.writeBuffer(
            lighting.buffer,
            0,
            sampleCase.missing ? missingDescriptors.buffer : coarseDescriptors.buffer,
            0,
            coarseDescriptors.byteLength,
          );
          samplingWords[46] = sampleCase.mode;
          command.writeBuffer(modifiedConstants, 0, samplingWords.buffer, 0, 256);
        }
        const entries = sourceFrame.lightingEntries.map((entry) =>
          entry.binding === 8 && sampleCase.mode !== null
            ? { binding: 8, resource: { buffer: modifiedConstants } }
            : entry.binding === 2
              ? { binding: 2, resource: { buffer: lighting.nativeBuffer } }
              : entry.binding === 9
                ? { binding: 9, resource: { buffer: lighting.ranges } }
                : entry,
        );
        if (sampleCase.exposure !== undefined) {
          const exposure = new Float32Array([sampleCase.exposure]);
          command.writeBuffer(exposureBuffer, 0, exposure.buffer, 0, 4);
        }
        capture = true;
        renderer._surface.prepareFrameNow({
          ...sourceFrame,
          preExposure: sampleCase.exposure === undefined ? sourceFrame.preExposure : exposureBuffer,
          lightingEntries: entries,
          scgi: { ...sourceGi, lighting, command },
        });
        renderer._surface.encode(command.gpu_encoder);
        let shadowRead = null;
        if (options.gather === true) {
          const gather = sourceGi.gather;
          command.clearBuffer(gather.owner.work, 48, 8);
          gather.owner.encode({ ...gather, transaction: { ...gather.transaction, command } });
          shadowRead = device.createBuffer({
            size: 64,
            usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
          });
          command.copyBufferToBuffer(gather.owner.work, 0, shadowRead, 0, 64);
        }
        command.finish();
        renderer._surface.commit(command.gpuDone);
        await command.gpuDone;
        const result = await read();
        if (shadowRead !== null) {
          await shadowRead.mapAsync(GPUMapMode.READ);
          const counters = new Uint32Array(shadowRead.getMappedRange());
          result.source.shadowRays = counters[12];
          result.source.reusedVisibility = counters[13];
          if (sampleCase.missing) {
            assert.equal(result.source.qualified, 0, "missing neutral-one VSM must not qualify");
            assert.equal(counters[13], 0, "missing VSM must not reuse visibility");
            assert.ok(counters[12] > 0, "nonzero missing visibility must reach real software query");
          }
          shadowRead.unmap();
          shadowRead.destroy();
        }
        capture = false;
        if (options.gather === true) {
          assert.equal(result.source.count, full.source.count);
          for (let word = 0; word < full.source.preparation.length; word++) {
            if (word % 12 === 11 && sampleCase.mode !== null) continue;
            assert.equal(
              result.source.preparation[word],
              full.source.preparation[word],
              `Native source preparation changed across ${sampleCase.name}/${route}, word=${word}`,
            );
          }
        }
        assert.equal(result.remapped, remap);
        if (route === "stripe") assert.ok(result.windows > 1);
        if (route === "full") expected = result.rgb;
        // A live VSM directory may itself force remapping at this projected
        // limit; each path below must retain every actual descriptor.
        for (let index = 0; index < expected.length && !sampleCase.missing; index++) {
          assert.equal(
            result.rgb[index],
            expected[index],
            `${sampleCase.name}/${route} HDR differs at ${index}`,
          );
        }
        windowResults.push({
          case: sampleCase.name,
          windows: result.windows,
          remapped: result.remapped,
          valid: result.valid,
          source:
            result.source === null
              ? null
              : {
                  count: result.source.count,
                  prepared: result.source.prepared,
                  qualified: result.source.qualified,
                  missing: result.source.missing,
                  shadowRays: result.source.shadowRays,
                  reusedVisibility: result.source.reusedVisibility,
                  visibility: result.source.visibility,
                },
        });
        directory.destroy();
      }
    }
    modifiedConstants.destroy();
    exposureBuffer.destroy();
    const graph = renderer.mainFrameGraphEvidence();
    assert.ok(graph.program.products.includes("indirect-diffuse"));
    assert.ok(graph.program.stages.indexOf("surface-cache-gi") < graph.program.stages.indexOf("surface"));
    const generation = renderer._scgi.runtime.activeGeneration;
    assert.equal(generation, 9);
    camera.transform.position.x = 0.1;
    camera.update();
    await tick();
    assert.equal(renderer._scgi.runtime.activeGeneration, generation + 1);
    // Abort after all producers and Native encoded: active roles stay put and
    // retry must not use the destroyed candidate estimator/query closure.
    injectedAbort = true;
    const beforeAbort = renderer.frame_count;
    let aborted = false;
    const abortDeadline = performance.now() + 60_000;
    while (!aborted) {
      assert.ok(performance.now() < abortDeadline);
      try {
        renderer.render(camera, scene);
      } catch (error) {
        assert.ok(/intentional pre-submit abort/.test(error.message), error.message);
        aborted = true;
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(renderer.frame_count, beforeAbort);
    assert.equal(renderer._scgi.runtime.activeGeneration, generation + 1);
    await tick();
    const estimatorBeforeLight = renderer._scgi.estimator;
    light.intensity = 7;
    await tick();
    assert.equal(
      renderer._scgi.estimator,
      estimatorBeforeLight,
      "numeric light edits reuse pipelines/query batches",
    );
    const originalQuery = renderer._scgi.scenes.current;
    meshes[0].transform_local.position.x += 0.05;
    meshes[0].updateMatrices();
    enclosure.emissive_factor.set(10000, 3000, 1000);
    await tick();
    assert.ok(
      renderer._scgi.scenes.current !== originalQuery,
      "rigid/material edits replace current query truth",
    );
    assert.equal(renderer._scgi.runtime.poisoned, false);
    renderer.setAmbientOcclusionSettings({ enabled: true });
    renderer.setScreenSpaceReflectionsSettings({ enabled: true });
    await tick();
    assert.ok(renderer.mainFrameGraphEvidence().program.stages.includes("sssr"));
    const inventory = renderer._scgi.estimator.input.scene.materials.source.materials
      .filter(
        (material) =>
          material.binding.layoutEntries.filter((entry) => entry.texture !== undefined).length === 10,
      )
      .map((material) =>
        nativeSurfaceBindingGroups(material.binding.layoutEntries, {
          compact: true,
          productGeometry: true,
          unlit: false,
          reactive: true,
          finalPixel: true,
          physicalSun: true,
          virtualTextures: true,
          reflections: "sssr-base-coat",
        }),
      );
    // Actual custom source is dispatched by the production Surface above.
    assert.equal(inventory.length, 1);
    const fullInventory = inventory[0].flat();
    const storageBindings = fullInventory.filter((entry) => entry.buffer?.type?.includes("storage")).length;
    const sampledBindings = fullInventory.filter((entry) => entry.texture !== undefined).length;
    assert.equal(storageBindings, 16);
    assert.equal(sampledBindings, 16);
    renderer.setResolutionScale(0.73);
    await tick();
    assert.equal(renderer._temporalPolicy, "upscale");
    renderer.setResolutionScale(1);
    renderer.fsr3_enabled = false;
    await tick();
    assert.equal(renderer._temporalPolicy, "bypass");
    if (options.gather === true) {
      const gatherCost = renderer._scgi.cost.gather;
      // Exercise the Final-Pixel Unlit binding profile without a GI/light
      // directory. Mixed lit/Unlit above cannot cover its disabled ranges.
      capture = false;
      renderer.setSurfaceCacheGiSettings({ enabled: false });
      renderer.setAmbientOcclusionSettings({ enabled: false });
      renderer.setScreenSpaceReflectionsSettings({ enabled: false });
      scene = new Scene();
      const unlit = new StandardShadeMaterial();
      unlit.is_unlit = true;
      unlit.diffuse_color.set(0.5, 0.25, 0.125, 1);
      scene.add(Mesh.from(new BoxGeometry(), unlit));
      const unlitProduct = await cookSceneGeometryProductV1(scene, {
        module: await createDefaultWebGeometryCookerModule(),
        producerId: "scgi-unlit-disabled-source",
        producerVersion: "3",
        maxDecodedProductBytes: 32 * 1024 ** 2,
      });
      await renderer.uploadCookedSceneProduct(scene, unlitProduct);
      await tick();
      assert.equal(renderer._scgi, null);
      assert.deepEqual(errors, []);
      return {
        scope: "existing authored materials/window/Native/FSR3 slice before independent 4K and fault matrix",
        frames: renderer.frame_count,
        storageBindings,
        sampledBindings,
        windowResults,
        gather: gatherCost,
        unlitWithoutGi: true,
        errors,
      };
    }
    renderer.setResolutionScale(1);
    // Isolate mandatory GI segmentation from the independent SSSR memory ceiling.
    // The full AO/GI/SSSR combination was exercised above at admitted extents.
    renderer.setScreenSpaceReflectionsSettings({ enabled: false });
    renderer.resize(3840, 2160);
    camera.aspect = 3840 / 2160;
    camera.update();
    await tick();
    assert.ok(
      renderer._scgi.estimator.plan.screen.length > 1,
      JSON.stringify({
        extent: renderer.resolutionEvidence(),
        plan: renderer._scgi.estimator.plan.profile,
        segments: renderer._scgi.estimator.plan.screen.length,
        native: [nativeFrame.width, nativeFrame.height],
      }),
    );
    assert.ok(nativeFrame.scgi.lighting.plan.windowRows < 2160);
    renderer.resize(67, 51);
    renderer.setScreenSpaceReflectionsSettings({ enabled: true });
    camera.aspect = 67 / 51;
    camera.update();
    await tick();
    renderer.setSurfaceCacheGiSettings({ debug: "irradiance" });
    await tick();
    renderer.setSurfaceCacheGiSettings({ debug: "confidence" });
    await tick();
    renderer.setSurfaceCacheGiSettings({ debug: "off" });
    camera.transform.position.x = 0;
    camera.update();
    renderer.setSurfaceCacheGiSettings({ enabled: false });
    await tick();
    assert.equal(renderer._scgi, null);
    renderer.setSurfaceCacheGiSettings({ enabled: true });
    await tick();
    // Same existing local-light producer, forced finite index admission. Its
    // complete DIRECT overflow mode must survive the GI directory consumer.
    const prepareLights = renderer._localLightWork.prepare.bind(renderer._localLightWork);
    renderer._localLightWork.prepare = (request) => {
      const frame = prepareLights({ ...request, indexCapacity: 1, taskBudget: 1 });
      localOverflowRead = {
        source: frame.data,
        buffer: device.createBuffer({ size: 128, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST }),
      };
      return frame;
    };
    for (let index = 0; index < 40; index++) {
      const extra = new PointLight();
      extra.position.set(index * 0.01, 1, 1);
      extra.intensity = 0.1;
      scene.add(extra);
    }
    await tick();
    renderer._localLightWork.prepare = prepareLights;
    await localOverflowRead.buffer.mapAsync(GPUMapMode.READ);
    const overflowHeader = Array.from(new Uint32Array(localOverflowRead.buffer.getMappedRange()));
    assert.equal(overflowHeader[1], 1, "local overflow selects complete DIRECT mode");
    assert.ok(overflowHeader[2] !== 0, "overflow reason is visible");
    localOverflowRead.buffer.unmap();
    localOverflowRead.buffer.destroy();
    localOverflowRead = undefined;
    const overflowSource = renderer.mainFrameGraphEvidence();
    assert.ok(overflowSource.program.stages.includes("local-light-work"));
    const beforeNotification = renderer.frame_count;
    const notifiedOwner = renderer._scgi;
    injectNotification = true;
    let notification = false;
    const notificationDeadline = performance.now() + 60_000;
    while (!notification) {
      assert.ok(performance.now() < notificationDeadline);
      try {
        renderer.render(camera, scene);
      } catch (error) {
        assert.ok(/intentional submitted notification/.test(error.message), error.message);
        notification = true;
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(renderer.frame_count, beforeNotification + 1);
    assert.equal(notifiedOwner.runtime.poisoned, true);
    await device.queue.onSubmittedWorkDone();
    assert.ok(
      renderer._finalPixelLighting.allocatedBytes > 0,
      "submitted failure retains quarantined directory",
    );
    const desired = renderer.surfaceCacheGiSettings;
    device.destroy();
    await device.lost;
    renderer = await renderer.recoverAfterDeviceLoss();
    device = renderer.device;
    device.addEventListener("uncapturederror", (event) => errors.push(event.error.message));
    assert.deepEqual(renderer.surfaceCacheGiSettings, desired);
    renderer.temporal_jitter_enabled = false;
    await tick();
    const submitCountBeforeCancel = renderer.frame_count;
    renderer.render(camera, scene);
    renderer.resize(69, 53);
    camera.transform.position.x += 0.05;
    camera.aspect = 69 / 53;
    camera.update();
    await tick();
    assert.ok(renderer.frame_count > submitCountBeforeCancel);
    const empty = new Scene();
    const emptyInitial = renderer.frame_count;
    while (renderer.frame_count === emptyInitial) {
      renderer.render(camera, empty);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await device.queue.onSubmittedWorkDone();
    assert.equal(renderer._scgi, null, "empty scene retires the last GI domain after replacement submit");
    await tick();
    const alternate = new Scene();
    const alternateMaterial = new StandardShadeMaterial();
    alternateMaterial.emissive_factor.set(1, 0, 0);
    alternate.add(Mesh.from(new BoxGeometry(), alternateMaterial));
    const alternateProduct = await cookSceneGeometryProductV1(alternate, {
      module: await createDefaultWebGeometryCookerModule(),
      producerId: "scgi-production-scene-switch",
      producerVersion: "8",
      maxDecodedProductBytes: 32 * 1024 ** 2,
    });
    await renderer.uploadCookedSceneProduct(alternate, alternateProduct);
    scene = alternate;
    await tick();
    assert.ok(renderer._scgi !== null);
    assert.deepEqual(errors, []);
    return {
      frames: renderer.frame_count,
      generation,
      oddExtent: [65, 49],
      valid: full.valid,
      positive: full.positive,
      windowResults,
      abortRetry: true,
      combinations: true,
      storageBindings,
      sampledBindings,
      internal4k: true,
      recovery: true,
      submittedNotification: true,
      localOverflow: true,
      sceneSwitch: true,
      hdrMaterial: true,
      rigidMutation: true,
      pendingResize: true,
      errors,
    };
  } finally {
    await device.queue.onSubmittedWorkDone();
    renderer.destroy();
  }
}
