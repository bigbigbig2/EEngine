import assert from "node:assert/strict";
import { GpuScene } from "../../.test-dist/gpu/GpuScene.js";
import { GeometryProductMultiRuntimeV1 } from "../../.test-dist/gpu/GeometryProductMultiRuntime.js";
import { GpuNativeMaterialScene } from "../../.test-dist/gpu/GpuNativeMaterialScene.js";
import { AppearanceProgramRegistry } from "../../.test-dist/gpu/AppearanceProgramRegistry.js";
import {
  ShaderModuleCache,
  PipelineLayoutCache,
  RenderPipelineCache,
  ComputePipelineCache,
  BindGroupCache
} from "../../.test-dist/gpu/GPUDescriptorCaches.js";
import { GraphicsContext } from "../../.test-dist/gpu/GraphicsContext.js";
import { GPUSamplerCache } from "../../.test-dist/gpu/GPUSamplerCache.js";
import { ResourceAccounting } from "../../.test-dist/debug/profiling/ResourceAccounting.js";
import { StandardShadeMaterial } from "../../.test-dist/material/StandardShadeMaterial.js";
import { AppearanceGraphBuilder } from "../../.test-dist/material/AppearanceGraph.js";
import { compileAppearanceGraph } from "../../.test-dist/material/AppearanceGraphCompiler.js";
import { ScgiQueryScene } from "../../.test-dist/render/gi/ScgiQueryScene.js";
import { ScgiEstimator } from "../../.test-dist/render/gi/ScgiEstimator.js";
import { ScgiFilter } from "../../.test-dist/render/gi/ScgiFilter.js";
import { ScgiRuntime } from "../../.test-dist/render/gi/ScgiRuntime.js";
import { ScgiCache } from "../../.test-dist/render/gi/ScgiCache.js";
import { packScgiRecord } from "../../.test-dist/render/gi/ScgiAbi.js";
import { GPULightCollection } from "../../.test-dist/gpu/LightDatabase.js";
import { GPUDatabase } from "../../.test-dist/gpu/GPUDatabase.js";
import { prepareAuthoredEnvironmentPipelines } from "../../.test-dist/gpu/GpuAuthoredEnvironment.js";
import { SceneLights } from "../../.test-dist/scene/Scene.js";
import { PointLight } from "../../.test-dist/light/PointLight.js";
import { SpotLight } from "../../.test-dist/light/SpotLight.js";
import { DirectionalLight } from "../../.test-dist/light/DirectionalLight.js";
import { PhysicalEnvironmentRuntime } from "../../.test-dist/render/environment/PhysicalEnvironmentRuntime.js";
import { PhysicalEnvironmentInput } from "../../.test-dist/render/environment/PhysicalEnvironmentState.js";
import { ShadeImage } from "../../.test-dist/texture/ShadeImage.js";
import { ShadeTexture } from "../../.test-dist/texture/ShadeTexture.js";
import { triangleProductFixture } from "../helpers/geometry-product-fixture.mjs";
import { scgiGraphics, scgiCommand, scgiProfile } from "./scgi-fixture.mjs";

const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const cacheSettings = {
  originEpoch: 1,
  camera: [0, 0, 0],
  voxelSize: 1,
  bounceEnabled: true,
  evictionAge: 1000,
  moveBudget: 0,
  normalCosine: 0.9,
  planeDistanceScale: 0.1,
  updateAge: 1,
  varianceThreshold: 1
};

/** Real Product/scene/native/light/cache/query owners. Analytic sky expectations
 * use continuous solid-angle integrals, independent of the GPU PRNG/projection. */
export async function runScgiEstimatorGpuOracle(device) {
  const graphics = scgiGraphics(device);
  const shaders = new ShaderModuleCache(device),
    layouts = new PipelineLayoutCache(device);
  graphics.appearance_programs = new AppearanceProgramRegistry(device);
  graphics.samplers = new GPUSamplerCache(device);
  graphics.render_pipelines = new RenderPipelineCache(device, layouts, shaders);
  graphics.compute_pipelines = new ComputePipelineCache(device, layouts, shaders);
  graphics.bind_groups = new BindGroupCache(device, layouts);
  graphics.setPipelineBindings = GraphicsContext.prototype.setPipelineBindings;
  graphics.resource_accounting = new ResourceAccounting();
  graphics.texture_residency = { virtualTextures: null, retainQuery: () => ({ valid: true, release() {} }) };
  const scene = new GpuScene(device, {}),
    products = new GeometryProductMultiRuntimeV1(device);
  const lights = new GPULightCollection(graphics, new SceneLights());
  const runtime = new ScgiRuntime(device, 1);
  let native, query, estimator, pending;
  const retained = [];
  let physical;
  const querySet = device.features.has("timestamp-query")
    ? device.createQuerySet({ type: "timestamp", count: 2 })
    : null;
  const timestampBuffer = querySet
    ? device.createBuffer({ size: 16, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC })
    : null;
  const gpuCosts = [];
  try {
    await GPUDatabase.preparePipelines(graphics);
    await prepareAuthoredEnvironmentPipelines(graphics);
    const { descriptor, page } = triangleProductFixture();
    const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", page)).slice(0, 16);
    descriptor.pageRecords.set(hash);
    const product = await products.load({
      descriptor,
      async readPage(pageId) {
        return {
          productId: descriptor.productId,
          revision: descriptor.revision,
          pageId,
          bytes: page.slice().buffer,
          decodedHash128: hash,
          decodedPageHash128: hash
        };
      },
      release() {}
    });
    const builder = new AppearanceGraphBuilder();
    builder.output("baseColor", builder.constant([0, 0, 0]));
    builder.output("emissive", builder.constant([1, 2, 4]));
    const upload = scgiCommand(graphics);
    pending = upload;
    const transform = [...identity];
    transform[12] = 100;
    let handle = scene.instantiate(
      {
        count: 1,
        geometryHandles: [],
        virtualGeometry: {
          productTableSlot: product.productTableSlot,
          productGeneration: product.productGeneration,
          assetCount: 1
        },
        geometryIndices: new Uint32Array([product.assetReferenceBegin]),
        materialHandles: new Uint32Array([0]),
        currentTransforms: new Float32Array(transform),
        flags: new Uint32Array([1 | 16]),
        boundsSpheres: new Float32Array([0, 0, 0, 1]),
        boundsMin: new Float32Array([-0.5, -0.5, 0]),
        boundsMax: new Float32Array([0.5, 0.5, 0])
      },
      upload
    );
    native = new GpuNativeMaterialScene(
      graphics,
      [
        {
          materialSlot: 0,
          material: new StandardShadeMaterial(),
          graph: compileAppearanceGraph(builder.build()),
          textureBindingSetId: 0,
          textureRefs: new Map()
        }
      ],
      () => [{ id: 0, generation: 1, textureBanks: [] }],
      new Map(),
      new Map(),
      upload,
      true,
      false
    );
    await native.ready;
    const image = new ShadeImage();
    image.width = image.height = image.depth = 1;
    image.source = new Float32Array([1, 2, 4, 1]).buffer;
    image.data_type = "float32";
    lights.source.environment = ShadeTexture.from(image);
    lights.update(upload);
    upload.finish();
    await upload.gpuDone;
    pending = null;
    native.setQueryProjectionEnabled(true);
    const deadline = performance.now() + 30000;
    while (!native.canPrepareFrame()) {
      assert.ok(performance.now() < deadline);
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    const prepare = scgiCommand(graphics);
    native.prepareFrame(prepare);
    prepare.finish();
    await prepare.gpuDone;
    query = await ScgiQueryScene.create(
      device,
      { deviceEpoch: 1, originEpoch: 1, primitiveCapacity: 8, maximumBytes: 8 * 1024 ** 2, subgroup: false },
      { nativeMaterials: native, virtualGeometry: products },
      scene,
      [product.residency]
    );
    const build = scgiCommand(graphics);
    query.encode(build);
    build.finish();
    await build.gpuDone;
    const profile = { ...scgiProfile, width: 1, height: 1, updates: 1, patches: 4, requests: 2 };
    const plan = await runtime.configure(
      { enabled: true, hasGeometry: true, hasLitMaterials: true },
      profile
    );
    const cache = await ScgiCache.create(device, plan);
    const filter = await ScgiFilter.create(device, plan);
    estimator = await ScgiEstimator.create(
      device,
      plan,
      { lightSamples: 4, hemisphereSamples: 512, connectionSamples: 4, maximumLights: 256, batchRays: 4 },
      {
        scene: query,
        lights,
        physical: null,
        environment: "authored-preserve-asset",
        authoredSolarDisk: "absent",
        view: identity,
        camera: [0, 0, 2],
        coneWidth: 0.01,
        coneSpread: 0,
        rayDistance: Infinity,
        environmentScale: 1,
        lightingEpoch: 1,
        environmentEpoch: 1,
        multiBounce: true,
        powerSampling: true,
        normalCosine: 0.9,
        planeDistanceScale: 0.1
      }
    );
    let frame = 0;
    let sceneEpoch = 1;
    let voxelSize = 1;
    const run = async (
      owner,
      {
        abort = false,
        patchPosition = [0, 0, 0],
        patchNormal = [0, 0, 1],
        before,
        after,
        filtered = false
      } = {}
    ) => {
      const command = scgiCommand(graphics);
      pending = command;
      const tx = runtime.prepare(command, { scene: sceneEpoch, view: 1 });
      runtime.encode(tx);
      const request = packScgiRecord("request", {
        positionRadius: [...patchPosition, 0],
        normal: patchNormal,
        source: 0,
        identity: new Uint32Array(12).fill(1),
        cellRankPixelStatus: [0, 0, 0, 0],
        identityTail: [0, 0, 0, 0]
      });
      command.uploadRegions([
        {
          destination: tx.publication.privateScratch.buffer,
          destinationOffset: plan.scratch.ranges.requests.offset,
          bytes: request
        },
        {
          destination: tx.publication.privateScratch.buffer,
          destinationOffset: plan.scratch.ranges.cacheControl.offset,
          bytes: new Uint8Array(new Uint32Array([1]).buffer)
        }
      ]);
      cache.encode(tx, { ...cacheSettings, voxelSize, frame: frame + 1 });
      before?.(tx);
      if (querySet) {
        const pass = command.gpu_encoder.beginComputePass({
          timestampWrites: { querySet, beginningOfPassWriteIndex: 0 }
        });
        pass.end();
      }
      owner.encode(tx);
      if (filtered) {
        filter.encode(tx, {
          frame: frame + 1,
          geometryEpoch: 1,
          filterEpoch: 1,
          spatial: true,
          post: true,
          spatialTaps: 4,
          lookupTaps: 4,
          spatialRadius: 1,
          lookupRadius: 0.5,
          normalCosine: 0.9,
          planeDistanceScale: 0.1,
          shortHysteresis: 0.5,
          longHysteresis: 0.98,
          postHysteresis: 0.8,
          driftScale: 0.25,
          maximumCount: 32,
          maximumAge: 8,
          invalidDecay: 0.5,
          revisionDecay: 0.25
        });
      }
      if (querySet) {
        const pass = command.gpu_encoder.beginComputePass({
          timestampWrites: { querySet, endOfPassWriteIndex: 1 }
        });
        pass.end();
        command.gpu_encoder.resolveQuerySet(querySet, 0, 2, timestampBuffer, 0);
      }
      after?.(tx);
      const read = device.createBuffer({
        size: 64 + plan.world.bytes + owner.buffer.size + 16,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
      });
      try {
        command.copyBufferToBuffer(
          tx.publication.privateScratch.buffer,
          plan.scratch.ranges.raw.offset,
          read,
          0,
          64
        );
        command.copyBufferToBuffer(tx.publication.candidateWorld.buffer, 0, read, 64, plan.world.bytes);
        command.copyBufferToBuffer(owner.buffer, 0, read, 64 + plan.world.bytes, owner.buffer.size);
        if (timestampBuffer)
          command.copyBufferToBuffer(timestampBuffer, 0, read, 64 + plan.world.bytes + owner.buffer.size, 16);
        if (abort) {
          command.abort(new Error("pre-submit estimator retry"));
          await command.gpuDone.catch(() => {});
          return null;
        }
        command.finish();
        await command.gpuDone;
        frame++;
        pending = null;
        await read.mapAsync(GPUMapMode.READ);
        const bytes = read.getMappedRange().slice(0);
        read.unmap();
        if (querySet) {
          const stamps = new BigUint64Array(bytes, 64 + plan.world.bytes + owner.buffer.size, 2);
          gpuCosts.push(Number(stamps[1] - stamps[0]) / 1e6);
        }
        return {
          f: new Float32Array(bytes, 0, 12),
          u: new Uint32Array(bytes, 48, 4),
          world: new Uint32Array(bytes, 64, plan.world.bytes / 4),
          estimate: new Uint32Array(bytes, 64 + plan.world.bytes),
          bytes
        };
      } finally {
        read.destroy();
      }
    };
    const first = await run(estimator);
    const actualFiltered = await run(estimator, { filtered: true });
    const actualPatch = plan.world.ranges.patches.offset / 4;
    assert.equal(
      actualFiltered.world[actualPatch + 24],
      1,
      "actual estimator cohort increments filter count"
    );
    const actualWorld = new Float32Array(actualFiltered.bytes, 64, plan.world.bytes / 4);
    assert.ok(
      Math.abs(actualWorld[actualPatch + 40] - actualFiltered.f[0]) < 1e-5,
      "real estimator raw is the sole A0 input"
    );
    const { f, u } = { f: first.f, u: new Uint32Array(first.bytes, 0, 16) };
    assert.equal(u[14], 1, `sky cohort fault ${u[15]}`);
    for (let channel = 0; channel < 3; channel++) {
      const expected = Math.PI * 2 ** channel;
      const actual = f[channel] * 0.28209479177387814 + f[9 + channel] * 0.4886025119029199;
      // Hoeffding: uniform z in [0,1], N=512; bound 0.15pi per channel
      // gives failure probability <2 exp(-2*512*.15^2) < 2e-10.
      assert.ok(Math.abs(actual - expected) < expected * 0.15, `${actual} vs ${expected}`);
    }
    const skyCost = estimator.cost;
    // Retry consumes neither patch serial nor frame cohort seed.
    await run(estimator, { abort: true });
    const retry = await run(estimator);
    const patchBase = plan.world.ranges.patches.offset / 4;
    assert.equal(retry.world[patchBase + 25], 3 * (512 + 4));
    assert.equal(retry.u[2], 1);
    sceneEpoch++;
    const tilted = await run(estimator, { patchNormal: [0.6, 0, 0.8] });
    assert.equal(tilted.u[2], 1);
    for (const n of [
      [0.6, 0, 0.8],
      [-0.6, 0, -0.8],
      [0.8, 0, -0.6]
    ]) {
      const actual =
        tilted.f[0] * 0.28209479177387814 +
        (tilted.f[3] * n[0] + tilted.f[6] * n[1] + tilted.f[9] * n[2]) * 0.4886025119029199;
      const expected = (Math.PI * (1 + n[0] * 0.6 + n[2] * 0.8)) / 2;
      assert.ok(Math.abs(actual - expected) < Math.PI * 0.15, `tilted hemisphere ${actual}/${expected}`);
    }
    sceneEpoch++;
    const opposite = await run(estimator, { patchNormal: [-0.6, 0, -0.8] });
    assert.equal(opposite.u[2], 1);
    for (const n of [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1]
    ]) {
      const combined = [0, 3, 6, 9].map((i) => tilted.f[i] + opposite.f[i]);
      const actual =
        combined[0] * 0.28209479177387814 +
        (combined[1] * n[0] + combined[2] * n[1] + combined[3] * n[2]) * 0.4886025119029199;
      assert.ok(
        Math.abs(actual - Math.PI) < Math.PI * 0.2,
        "opposite hemispheres recover global constant SH"
      );
    }
    retained.push(estimator);
    estimator = null;
    sceneEpoch++;

    // Replace real GpuScene instances/native materials, keeping Product payload
    // shared. The source is deliberately not a private test-only ray scene.
    const replaceScene = async (
      base,
      emission,
      {
        scale = 4,
        z = 1,
        alpha = false,
        shadow = true,
        domain,
        second = false,
        blocker = false,
        blockerCasts = true,
        doubleSided = true,
        xy = 0,
        endpointBlocker = false
      } = {}
    ) => {
      if (query) {
        await query.releaseAfter(Promise.resolve());
        query = null;
      }
      const command = scgiCommand(graphics);
      pending = command;
      scene.release(handle, command);
      const transform = [...identity];
      transform[0] = transform[5] = scale;
      transform[12] = transform[13] = xy;
      transform[14] = z;
      const transforms = second || blocker || endpointBlocker ? [...transform, ...transform] : transform;
      if (second) transforms[16 + 12] = 10;
      if (blocker) {
        transforms[16] = transforms[21] = 100;
        transforms[30] = -1;
      }
      if (endpointBlocker) transforms[30] = 0.5;
      const count = second || blocker || endpointBlocker ? 2 : 1;
      const flags = new Uint32Array(count).fill(
        1 | 4 | (doubleSided ? 16 : 0) | (shadow ? 2 : 0) | (alpha ? 8 : 0)
      );
      if (blocker && !blockerCasts) flags[1] &= ~2;
      handle = scene.instantiate(
        {
          count,
          geometryHandles: [],
          virtualGeometry: {
            productTableSlot: product.productTableSlot,
            productGeneration: product.productGeneration,
            assetCount: 1
          },
          geometryIndices: new Uint32Array(count).fill(product.assetReferenceBegin),
          materialHandles: new Uint32Array(count),
          currentTransforms: new Float32Array(transforms),
          flags,
          boundsSpheres: new Float32Array(count * 4).fill(1),
          boundsMin: new Float32Array(count === 2 ? [-0.5, -0.5, 0, -0.5, -0.5, 0] : [-0.5, -0.5, 0]),
          boundsMax: new Float32Array(count === 2 ? [0.5, 0.5, 0, 0.5, 0.5, 0] : [0.5, 0.5, 0])
        },
        command
      );
      native.destroy();
      const builder = new AppearanceGraphBuilder();
      builder.output("baseColor", builder.constant(base));
      builder.output("emissive", builder.constant(emission));
      builder.output("alpha", builder.constant(alpha ? 0 : 1));
      const material = new StandardShadeMaterial();
      if (alpha) material.transparency_mode = 1;
      native = new GpuNativeMaterialScene(
        graphics,
        [
          {
            materialSlot: 0,
            material,
            graph: compileAppearanceGraph(builder.build()),
            textureBindingSetId: 0,
            textureRefs: new Map()
          }
        ],
        () => [{ id: 0, generation: 1, textureBanks: [] }],
        new Map(),
        new Map(),
        command,
        true,
        false
      );
      await native.ready;
      command.finish();
      await command.gpuDone;
      pending = null;
      native.setQueryProjectionEnabled(true);
      const deadline = performance.now() + 30000;
      while (!native.canPrepareFrame()) {
        assert.ok(performance.now() < deadline);
        await new Promise((r) => setTimeout(r, 1));
      }
      const prepare = scgiCommand(graphics);
      native.prepareFrame(prepare);
      prepare.finish();
      await prepare.gpuDone;
      query = await ScgiQueryScene.create(
        device,
        {
          deviceEpoch: 1,
          originEpoch: 1,
          primitiveCapacity: 8,
          maximumBytes: 8 * 1024 ** 2,
          subgroup: false,
          ...(domain ? { domain } : {})
        },
        { nativeMaterials: native, virtualGeometry: products },
        scene,
        [product.residency]
      );
      const build = scgiCommand(graphics);
      query.encode(build);
      build.finish();
      await build.gpuDone;
    };
    const createEstimator = async (options = {}, samples = {}) =>
      ScgiEstimator.create(
        device,
        plan,
        {
          lightSamples: 2048,
          hemisphereSamples: 64,
          connectionSamples: 256,
          maximumLights: 256,
          batchRays: 256,
          ...samples
        },
        {
          scene: query,
          lights,
          physical: null,
          environment: "black",
          authoredSolarDisk: "absent",
          view: identity,
          camera: [0, 0, -2],
          coneWidth: 0.01,
          coneSpread: 0,
          rayDistance: Infinity,
          environmentScale: 1,
          lightingEpoch: lights.publicationRevision,
          environmentEpoch: 1,
          multiBounce: false,
          powerSampling: false,
          normalCosine: 0.9,
          planeDistanceScale: 0.1,
          ...options
        }
      );
    // Independent triangle area quadrature, not a second copy of the light-
    // origin proposal/Jacobian formula. Integrate the physical area measure.
    const areaReference = (
      sourceAt,
      sourceColor,
      range,
      coneCos = -1,
      penumbraCos = -1,
      sourceDirection = [0, 0, 1],
      receiver = [0, 0, 0],
      base = [1, 1, 1]
    ) => {
      const sum = [0, 0, 0],
        steps = 300;
      let secondMoment = 0;
      for (let i = 0; i < steps; i++)
        for (let j = 0; j < steps; j++) {
          const a = (i + 0.5) / steps,
            b = (j + 0.5) / steps;
          const y = [-2 + 4 * Math.sqrt(a) * (1 - b) + 2 * Math.sqrt(a) * b, -2 + 4 * Math.sqrt(a) * b, 1];
          const toLight = sourceAt.map((v, k) => v - y[k]),
            dl2 = toLight.reduce((v, x) => v + x * x, 0),
            dl = Math.sqrt(dl2);
          const toPatch = receiver.map((v, k) => v - y[k]),
            dp2 = toPatch.reduce((v, x) => v + x * x, 0),
            dp = Math.sqrt(dp2);
          const cosLight = Math.max(0, -toLight[2] / dl),
            cosPatch = Math.max(0, -toPatch[2] / dp);
          let window = range > 0 ? Math.max(0, 1 - (dl / range) ** 4) ** 2 : 1;
          if (coneCos > -1) {
            const cosine = -toLight.reduce((s, x, k) => s + x * sourceDirection[k], 0) / dl;
            const t =
              coneCos === penumbraCos
                ? Number(cosine >= coneCos)
                : Math.max(0, Math.min(1, (cosine - coneCos) / (penumbraCos - coneCos)));
            window *= t * t * (3 - 2 * t);
          }
          // Evaluate standard cosine-convolved L1 along receiver +Z directly:
          // convolution kernel is 1/4 + 1/2 cos(theta), with backside zero.
          const kernel = 0.25 + (0.5 * (y[2] - receiver[2])) / dp;
          for (let c = 0; c < 3; c++) {
            const density =
              (((((base[c] / Math.PI) * sourceColor[c] * window) / dl2) * cosLight * cosPatch) / dp2) *
              kernel;
            sum[c] += (8 / steps ** 2) * density;
            if (c === 0 && cosLight > 0) {
              const proposalArea = cosLight / (2 * Math.PI * (1 - coneCos) * dl2);
              secondMoment += ((8 / steps ** 2) * density ** 2) / proposalArea;
            }
          }
        }
      // Two-stage sampling with replacement: total variance of the final mean
      // is Var(g)/Npool + (1-1/Npool)*Var(g)/Nconnect. No-hit g=0 is included.
      const variance = Math.max(0, secondMoment - sum[0] ** 2);
      return { value: sum, standardError: Math.sqrt(variance * (1 / 2048 + (1 - 1 / 2048) / 256)) };
    };
    const evaluate = (f) => [0, 1, 2].map((c) => f[c] * 0.28209479177387814 + f[9 + c] * 0.4886025119029199);
    await replaceScene([0, 0, 0], [1, 2, 4], { shadow: false, second: true });
    estimator = await createEstimator({}, { hemisphereSamples: 256, connectionSamples: 1, lightSamples: 1 });
    const emission = await run(estimator);
    assert.equal(emission.u[2], 1);
    assert.ok(evaluate(emission.f)[0] > 0.2, "emission survives zero diffuse albedo and CastsShadow=false");
    const emissionValue = evaluate(emission.f);
    assert.ok(Math.abs(emissionValue[1] / emissionValue[0] - 2) < 1e-5);
    retained.push(estimator);
    estimator = null;
    await replaceScene([1, 1, 1], [0, 0, 0], { second: true });
    const point = new PointLight();
    point.position = [0, 0, 0];
    point.distance = 4;
    point.intensity = 2;
    point.updateMatrices();
    lights.source.add(point);
    let update = scgiCommand(graphics);
    lights.update(update);
    update.finish();
    await update.gpuDone;
    estimator = await createEstimator();
    const punctual = await run(estimator);
    assert.equal(punctual.u[2], 1, `punctual fault ${punctual.u[3]}`);
    const reference = areaReference([0, 0, 0], [2, 2, 2], 4);
    const actual = evaluate(punctual.f);
    assert.ok(
      Math.abs(actual[0] - reference.value[0]) < 6 * reference.standardError + 1e-4,
      `area integral ${actual[0]} vs ${reference.value[0]} (SE ${reference.standardError})`
    );
    const e = punctual.estimate,
      poolRange = estimator.arena.ranges.pool;
    const pool = e.slice(poolRange.offset / 4, (poolRange.offset + poolRange.bytes) / 4);
    assert.ok(
      Array.from({ length: 2048 }, (_, i) => pool[i * 48 + 27]).some((v) => v === 1),
      "fixed pool retains physical no-hit slots"
    );
    assert.ok(punctual.estimate[5] > 0, "actual endpoint reconnection issued");
    const punctualCost = estimator.cost;
    assert.ok(punctual.estimate[22] > 0, "correct instance endpoints contribute");
    // A changed light snapshot is rejected before an old pool can be reused.
    lights.source.remove(point);
    update = scgiCommand(graphics);
    lights.update(update);
    update.finish();
    await update.gpuDone;
    const stale = scgiCommand(graphics);
    const tx = runtime.prepare(stale, { scene: sceneEpoch, view: 1 });
    runtime.encode(tx);
    let rejection;
    try {
      estimator.encode(tx);
    } catch (error) {
      rejection = error;
    }
    assert.ok(/publication changed/.test(String(rejection)), `stale light rejection ${rejection}`);
    stale.abort(new Error("stale light"));
    await stale.gpuDone.catch(() => {});
    retained.push(estimator);
    estimator = null;
    await replaceScene([1, 1, 1], [0, 0, 0], { endpointBlocker: true });
    const endpointLight = new PointLight();
    endpointLight.position = [0, 0, 2];
    endpointLight.distance = 4;
    endpointLight.intensity = 2;
    endpointLight.updateMatrices();
    lights.source.add(endpointLight);
    update = scgiCommand(graphics);
    lights.update(update);
    update.finish();
    await update.gpuDone;
    estimator = await createEstimator(
      {},
      { hemisphereSamples: 4, connectionSamples: 128, lightSamples: 256 }
    );
    const endpointBlocked = await run(estimator);
    assert.equal(endpointBlocked.u[2], 1);
    assert.ok(endpointBlocked.estimate[21] > 0, "same primitive in a different instance rejects endpoint");
    assert.ok(
      Array.from(endpointBlocked.f).every((x) => x === 0),
      "occluded endpoint contributes physical zero"
    );
    retained.push(estimator);
    estimator = null;
    lights.source.remove(endpointLight);
    await replaceScene([1, 1, 1], [0, 0, 0], { second: true });
    const spot = new SpotLight();
    spot.position = [0, 0, 0];
    spot.forward = [0, 0, 1];
    spot.angle = Math.PI / 3;
    spot.penumbra = 0.3;
    spot.distance = 4;
    spot.intensity = 2;
    spot.updateMatrices();
    lights.source.add(spot);
    update = scgiCommand(graphics);
    lights.update(update);
    update.finish();
    await update.gpuDone;
    estimator = await createEstimator({ powerSampling: true });
    const spotResult = await run(estimator);
    const spotReference = areaReference(
      [0, 0, 0],
      [2, 2, 2],
      4,
      Math.cos(spot.angle),
      Math.cos(spot.angle * (1 - spot.penumbra))
    );
    const spotActual = evaluate(spotResult.f);
    assert.equal(spotResult.u[2], 1);
    assert.ok(
      Math.abs(spotActual[0] - spotReference.value[0]) < 6 * spotReference.standardError + 1e-4,
      `spot area integral ${spotActual[0]} vs ${spotReference.value[0]} (SE ${spotReference.standardError})`
    );
    retained.push(estimator);
    estimator = null;
    spot.distance = 0.1;
    lights.source.needsUpdate = true;
    update = scgiCommand(graphics);
    lights.update(update);
    update.finish();
    await update.gpuDone;
    estimator = await createEstimator({}, { hemisphereSamples: 4, connectionSamples: 32, lightSamples: 32 });
    const rangeZero = await run(estimator);
    assert.equal(rangeZero.u[2], 1);
    assert.ok(
      Array.from(rangeZero.f).every((x) => x === 0),
      "range attenuation is physical zero with planned denominator"
    );
    retained.push(estimator);
    estimator = null;
    lights.source.remove(spot);
    const directional = new DirectionalLight();
    directional.forward = [0, 0, 1];
    directional.intensity = 2;
    lights.source.add(directional);
    update = scgiCommand(graphics);
    lights.update(update);
    update.finish();
    await update.gpuDone;
    estimator = await createEstimator({}, { hemisphereSamples: 256, connectionSamples: 1, lightSamples: 1 });
    const directionalLit = await run(estimator);
    assert.equal(directionalLit.u[2], 1);
    assert.ok(evaluate(directionalLit.f)[0] > 0.2, "authored directional uses world-space visibility at hit");
    retained.push(estimator);
    estimator = null;
    await replaceScene([1, 1, 1], [0, 0, 0], { blocker: true });
    estimator = await createEstimator({}, { hemisphereSamples: 32, connectionSamples: 1, lightSamples: 1 });
    const directionalBlocked = await run(estimator);
    assert.equal(directionalBlocked.u[2], 1);
    assert.ok(
      Array.from(directionalBlocked.f).every((x) => x === 0),
      "world directional shadow sees offscreen blocker"
    );
    retained.push(estimator);
    estimator = null;
    await replaceScene([1, 1, 1], [0, 0, 0], { blocker: true, blockerCasts: false });
    estimator = await createEstimator({}, { hemisphereSamples: 32, connectionSamples: 1, lightSamples: 1 });
    const noCast = await run(estimator);
    assert.equal(noCast.u[2], 1);
    assert.ok(evaluate(noCast.f)[0] > 0.2, "shadow mask is independent of transport surface membership");
    retained.push(estimator);
    estimator = null;
    lights.source.remove(directional);
    update = scgiCommand(graphics);
    lights.update(update);
    update.finish();
    await update.gpuDone;
    await replaceScene([0, 0, 0], [0, 0, 0], { alpha: true });
    estimator = await createEstimator(
      { environment: "authored-preserve-asset" },
      { hemisphereSamples: 256, connectionSamples: 1, lightSamples: 1 }
    );
    const throughAlpha = await run(estimator);
    assert.equal(throughAlpha.u[2], 1);
    assert.ok(
      Math.abs(evaluate(throughAlpha.f)[0] - Math.PI) < Math.PI * 0.2,
      "MASK rejects continue to certified environment"
    );
    retained.push(estimator);
    estimator = null;
    await replaceScene([1, 1, 1], [0, 0, 0], { domain: { min: [-5, -5, -5], max: [5, 5, 5] } });
    estimator = await createEstimator(
      { environment: "authored-preserve-asset" },
      { hemisphereSamples: 4, connectionSamples: 1, lightSamples: 1 }
    );
    const unknown = await run(estimator);
    assert.equal(unknown.u[2], 0);
    assert.ok((unknown.u[3] & 4) !== 0, "escaped unknown invalidates entire cohort");
    assert.ok(
      Array.from(unknown.f).every((x) => x === 0),
      "unknown cohort never publishes partial sky"
    );
    const unknownAgain = await run(estimator);
    assert.equal(unknownAgain.u[2], 0);
    assert.equal(
      unknownAgain.world[patchBase + 25],
      unknown.world[patchBase + 25] + 5,
      "failed attempts advance the sequence instead of resampling failed directions"
    );
    retained.push(estimator);
    estimator = null;
    await replaceScene([1, 1, 1], [0, 0, 0], { doubleSided: false, scale: 100 });
    estimator = await createEstimator({}, { hemisphereSamples: 32, connectionSamples: 1, lightSamples: 1 });
    const inside = await run(estimator);
    assert.equal(inside.u[2], 0, "single-sided backface invalidates the cohort");
    assert.ok(Array.from(inside.f).every((x) => x === 0));
    retained.push(estimator);
    estimator = null;
    await replaceScene([0.8, 0.2, 0.1], [0, 0, 0]);
    // Seed a previous committed A0 through real query-hit identities. This is
    // an isolated cache-input oracle, not an SCGI-7 filtering implementation.
    estimator = await createEstimator(
      { multiBounce: true },
      { hemisphereSamples: 64, connectionSamples: 1, lightSamples: 1 }
    );
    const born = await run(estimator);
    assert.ok(born.world[20] > 0, "rank0 missing cache emits bounded rank1 demand");
    const bounceOffset = plan.world.ranges.bounceRequests.offset / 4;
    const seedCommand = scgiCommand(graphics);
    pending = seedCommand;
    const seedTx = runtime.prepare(seedCommand, { scene: sceneEpoch, view: 1 });
    runtime.encode(seedTx);
    const sourcePoint = [...new Float32Array(born.bytes, 64 + plan.world.ranges.bounceRequests.offset, 3)];
    const req = packScgiRecord("request", {
      positionRadius: [0, 0, 0, 0],
      normal: [0, 0, 1],
      source: 0,
      identity: new Uint32Array(12).fill(1),
      cellRankPixelStatus: [0, 0, 0, 0],
      identityTail: [0, 0, 0, 0]
    });
    seedCommand.uploadRegions([
      {
        destination: seedTx.publication.privateScratch.buffer,
        destinationOffset: plan.scratch.ranges.requests.offset,
        bytes: req
      },
      {
        destination: seedTx.publication.privateScratch.buffer,
        destinationOffset: plan.scratch.ranges.cacheControl.offset,
        bytes: new Uint8Array(new Uint32Array([1]).buffer)
      }
    ]);
    cache.encode(seedTx, { ...cacheSettings, frame: frame + 1 });
    const seedPipeline = await device.createComputePipelineAsync({
      layout: "auto",
      compute: {
        entryPoint: "main",
        module: device.createShaderModule({
          code: `
@group(0) @binding(0) var<storage,read_write> world:array<u32>;
@compute @workgroup_size(1) fn main() {
  for(var slot=0u;slot<${profile.patches}u;slot++) {
    let at=${patchBase}u+slot*76u;
    if(world[${plan.world.ranges.cacheState.offset / 4}u+slot*4u+3u]==0u || world[at+68u]!=1u) {continue;}
    world[at+24u]=1u;
    world[at+40u]=bitcast<u32>(3.544907701811032);
    world[at+41u]=bitcast<u32>(7.089815403622064);
    world[at+42u]=bitcast<u32>(10.634723105433096);
    for(var epoch=0u;epoch<4u;epoch++) {world[at+64u+epoch]=world[4u+epoch];}
  }
}`
        })
      }
    });
    const seedPass = seedCommand.beginComputePass();
    seedPass.setPipeline(seedPipeline);
    seedPass.setBindGroup(
      0,
      device.createBindGroup({
        layout: seedPipeline.getBindGroupLayout(0),
        entries: [{ binding: 0, resource: { buffer: seedTx.publication.candidateWorld.buffer } }]
      })
    );
    seedPass.dispatchWorkgroups(1);
    seedPass.end();
    seedCommand.finish();
    await seedCommand.gpuDone;
    frame++;
    pending = null;
    let bounced;
    for (let attempt = 0; attempt < 4; attempt++) {
      const value = await run(estimator);
      if (value.estimate[17] > 0) {
        bounced = value;
        break;
      }
    }
    assert.ok(
      bounced,
      "multi-bounce scheduled rank0 must read previous committed A0 within update fairness cycle"
    );
    assert.equal(bounced.u[2], 1);
    assert.ok(bounced.estimate[17] > 0, "multi-bounce actually reads previous committed A0");
    const bounceValue = evaluate(bounced.f);
    assert.ok(
      bounceValue[0] > 0 &&
        Math.abs(bounceValue[1] / bounceValue[0] - 0.5) < 1e-4 &&
        Math.abs(bounceValue[2] / bounceValue[0] - 0.375) < 1e-4,
      "colored reflectance multiplies previous irradiance once"
    );
    // Mutate only candidate A0 before estimation. Previous-bank reads must be
    // unchanged. This oracle never installs a production A0 writer.
    const poisonCandidate = (tx) => {
      for (let slot = 0; slot < profile.patches; slot++) {
        tx.command.uploadRegions([
          {
            destination: tx.publication.candidateWorld.buffer,
            destinationOffset: plan.world.ranges.patches.offset + slot * 304 + 160,
            bytes: new Uint8Array(new Float32Array(12).fill(1e20).buffer)
          }
        ]);
      }
    };
    let isolated;
    for (let attempt = 0; attempt < 4; attempt++) {
      // Restore candidate values after estimation, before committing. Only the
      // in-command estimate sees poison; it must still use the previous bank.
      const saved = bounced.world;
      const value = await run(estimator, {
        before: poisonCandidate,
        after: (tx) => {
          for (let slot = 0; slot < profile.patches; slot++)
            tx.command.uploadRegions([
              {
                destination: tx.publication.candidateWorld.buffer,
                destinationOffset: plan.world.ranges.patches.offset + slot * 304 + 160,
                bytes: new Uint8Array(
                  saved.slice(patchBase + slot * 76 + 40, patchBase + slot * 76 + 52).buffer
                )
              }
            ]);
        }
      });
      if (value.estimate[17] > 0) {
        isolated = value;
        break;
      }
    }
    assert.ok(
      isolated && evaluate(isolated.f)[0] < 10,
      "candidate poison cannot enter previous A0 continuation"
    );
    retained.push(estimator);
    estimator = null;
    estimator = await createEstimator(
      { multiBounce: false },
      { hemisphereSamples: 32, connectionSamples: 1, lightSamples: 1 }
    );
    const bounceOff = await run(estimator);
    assert.equal(bounceOff.u[2], 1);
    assert.ok(
      Array.from(bounceOff.f).every((x) => x === 0),
      "black unlit enclosure has no continuation when disabled"
    );
    retained.push(estimator);
    estimator = null;
    // A symmetric two-wall Jacobi fixture: the other wall's irradiance is an
    // explicit previous-A0 boundary condition, not a counterfeit filter. With
    // a nearly hemispherical wall the independent transport operator is rho;
    // the exact finite triangle L1 projected form factor is integrated below.
    sceneEpoch++;
    voxelSize = 1000;
    await replaceScene([0.8, 0.2, 0.1], [0, 0, 0], { scale: 100, xy: 100 });
    estimator = await createEstimator(
      { multiBounce: true },
      { hemisphereSamples: 256, connectionSamples: 1, lightSamples: 1 }
    );
    await run(estimator, { patchPosition: [100, 100, 0] }); // One coarse rank1 wall entry.
    const seedBoundary = async (irradiance) => {
      const command = scgiCommand(graphics);
      pending = command;
      const tx = runtime.prepare(command, { scene: sceneEpoch, view: 1 });
      runtime.encode(tx);
      cache.encode(tx, { ...cacheSettings, voxelSize, frame: frame + 1 });
      const kernel = await device.createComputePipelineAsync({
        layout: "auto",
        compute: {
          entryPoint: "main",
          module: device.createShaderModule({
            code: `
@group(0) @binding(0) var<storage,read_write> world:array<u32>;
@compute @workgroup_size(1) fn main() {
  for(var slot=0u;slot<${profile.patches}u;slot++) {
    let at=${patchBase}u+slot*76u;
    if(world[${plan.world.ranges.cacheState.offset / 4}u+slot*4u+3u]==0u || world[at+68u]!=1u) {continue;}
    world[at+24u]=1u;
    for(var i=0u;i<12u;i++) {world[at+40u+i]=0u;}
    world[at+40u]=bitcast<u32>(${irradiance[0] * Math.sqrt(4 * Math.PI)});
    world[at+41u]=bitcast<u32>(${irradiance[1] * Math.sqrt(4 * Math.PI)});
    world[at+42u]=bitcast<u32>(${irradiance[2] * Math.sqrt(4 * Math.PI)});
    for(var i=0u;i<4u;i++) {world[at+64u+i]=world[4u+i];}
  }
}`
          })
        }
      });
      const pass = command.beginComputePass();
      pass.setPipeline(kernel);
      pass.setBindGroup(
        0,
        device.createBindGroup({
          layout: kernel.getBindGroupLayout(0),
          entries: [{ binding: 0, resource: { buffer: tx.publication.candidateWorld.buffer } }]
        })
      );
      pass.dispatchWorkgroups(1);
      pass.end();
      command.finish();
      await command.gpuDone;
      pending = null;
      frame++;
    };
    // Independent direction quadrature, geometric ray/triangle inclusion and
    // analytic standard-L1 convolution. It does not use the GPU's PRNG/cache.
    let formFactor = 0;
    for (let i = 0; i < 256; i++)
      for (let j = 0; j < 512; j++) {
        const z = (i + 0.5) / 256,
          phi = (2 * Math.PI * (j + 0.5)) / 512;
        const x = (Math.sqrt(1 - z * z) * Math.cos(phi)) / z,
          y = (Math.sqrt(1 - z * z) * Math.sin(phi)) / z;
        if (y >= -50 && y <= 50 && Math.abs(x) <= (50 - y) / 2)
          formFactor += (2 * (0.25 + 0.5 * z)) / (256 * 512);
      }
    const direct = [0.1, 0.2, 0.4],
      rho = [0.8, 0.2, 0.1];
    let boundary = [...direct];
    for (let iteration = 0; iteration < 18; iteration++) {
      await seedBoundary(boundary);
      let response;
      for (let attempt = 0; attempt < 4; attempt++) {
        const value = await run(estimator, { patchPosition: [100, 100, 0] });
        if (value.estimate[17] > 0) {
          response = value;
          break;
        }
      }
      assert.ok(response && response.u[2] === 1, "Jacobi uses complete actual previous-bank estimate");
      boundary = evaluate(response.f).map((v, c) => direct[c] + v);
    }
    const stationary = direct.map((v, c) => v / (1 - rho[c] * formFactor));
    for (let c = 0; c < 3; c++)
      assert.ok(
        Math.abs(boundary[c] - stationary[c]) < stationary[c] * 0.12,
        `colored Jacobi convergence ${boundary[c]} vs ${stationary[c]}`
      );
    retained.push(estimator);
    estimator = null;
    sceneEpoch++;
    voxelSize = 1;
    await replaceScene([0.8, 0.2, 0.1], [0, 0, 0]);
    // Existing atmosphere owner supplies real transmittance at hit altitude.
    // Reset only the fixture's scene epoch so the newly added rank1 workload
    // cannot select a different patch instead of this receiver's sun check.
    sceneEpoch++;
    physical = new PhysicalEnvironmentRuntime(device);
    await physical.preparePipelines();
    const environmentInput = new PhysicalEnvironmentInput();
    environmentInput.setSun([0, 0.6, -0.8], [1, 1, 1]);
    const environmentCommand = scgiCommand(graphics);
    pending = environmentCommand;
    const generation = physical.record(
      environmentCommand.gpu_encoder,
      environmentInput.snapshot(),
      [0, 0, 0]
    );
    physical.writeParameters((buffer, data) =>
      environmentCommand.writeBuffer(buffer, 0, data, 0, data.byteLength)
    );
    environmentCommand.onFinished.addOne(() => physical.commit(generation, environmentCommand.gpuDone));
    environmentCommand.onAborted.addOne(() => physical.abort(generation));
    environmentCommand.finish();
    await environmentCommand.gpuDone;
    pending = null;
    estimator = await createEstimator(
      { physical, multiBounce: false },
      { hemisphereSamples: 32, connectionSamples: 1, lightSamples: 1 }
    );
    const physicalSun = await run(estimator);
    assert.equal(physicalSun.u[2], 1);
    assert.ok(evaluate(physicalSun.f)[0] > 0, "physical solar LUT is consumed at world hit");
    retained.push(estimator);
    estimator = null;
    await replaceScene([0.8, 0.2, 0.1], [0, 0, 0], { blocker: true });
    estimator = await createEstimator(
      { physical },
      { hemisphereSamples: 32, connectionSamples: 1, lightSamples: 1 }
    );
    const physicalBlocked = await run(estimator);
    assert.equal(physicalBlocked.u[2], 1);
    assert.ok(
      Array.from(physicalBlocked.f).every((x) => x === 0),
      "physical solar ray is blocked in world space"
    );
    retained.push(estimator);
    estimator = null;
    // Enumerate beyond a small tile/first-N subset, including nonuniform powers
    // and zero power. Inspect the real GPU publication's support, then overflow
    // the declared capacity: it must fail the entire cohort, never truncate.
    const manyLights = [];
    for (let i = 0; i < 70; i++) {
      const light = new PointLight();
      light.position = [0, 0, 0];
      light.distance = 0.1;
      light.intensity = i;
      light.updateMatrices();
      lights.source.add(light);
      manyLights.push(light);
    }
    update = scgiCommand(graphics);
    lights.update(update);
    update.finish();
    await update.gpuDone;
    estimator = await createEstimator(
      { powerSampling: true },
      { hemisphereSamples: 4, connectionSamples: 1, lightSamples: 1 }
    );
    const fullLights = await run(estimator);
    assert.equal(fullLights.estimate[0], 70);
    assert.equal(fullLights.u[2], 1);
    const lightOffset = estimator.arena.ranges.lights.offset / 4;
    let cdf = 0;
    const indices = new Set();
    for (let i = 0; i < 70; i++) {
      const at = lightOffset + i * 4;
      indices.add(fullLights.estimate[at + 1]);
      const next = new Float32Array(
        fullLights.estimate.buffer,
        fullLights.estimate.byteOffset + (at + 3) * 4,
        1
      )[0];
      assert.ok(next > cdf, "every live light including zero power retains CDF support");
      cdf = next;
    }
    assert.equal(indices.size, 70);
    retained.push(estimator);
    estimator = null;
    estimator = await createEstimator(
      {},
      { maximumLights: 64, hemisphereSamples: 4, connectionSamples: 1, lightSamples: 1 }
    );
    const lightOverflow = await run(estimator);
    assert.equal(lightOverflow.u[2], 0);
    assert.ok(Array.from(lightOverflow.f).every((x) => x === 0));
    retained.push(estimator);
    estimator = null;
    return {
      raw: Array.from(f.slice(0, 12)),
      cohort: Array.from(u.slice(12)),
      cost: skyCost,
      gpuCostObservation: {
        firstSkyMs: gpuCosts[0] ?? null,
        maximumFixtureMs: gpuCosts.length ? Math.max(...gpuCosts) : null,
        submissions: gpuCosts.length,
        scope:
          "single sequential fixture timestamps; includes command gaps, not benchmark or throughput qualification"
      },
      emission: emissionValue,
      punctual: { actual, reference, cost: punctualCost },
      spot: { actual: spotActual, reference: spotReference },
      directional: evaluate(directionalLit.f),
      maskSky: evaluate(throughAlpha.f),
      unknown: Array.from(unknown.u),
      directionalBlocked: evaluate(directionalBlocked.f),
      noCast: evaluate(noCast.f),
      multiBounce: {
        sourcePoint,
        firstDemand: born.world[20],
        cacheHits: bounced.estimate[17],
        value: bounceValue
      },
      jacobi: {
        formFactor,
        actual: boundary,
        stationary,
        iterations: 18,
        scope: "actual GPU estimator, explicit previous-A0 boundary; SCGI-7 temporal writer not substituted"
      },
      physicalSun: evaluate(physicalSun.f),
      physicalBlocked: evaluate(physicalBlocked.f),
      fullLightCount: fullLights.estimate[0],
      endpointRejected: endpointBlocked.estimate[21],
      inside: Array.from(inside.u),
      lightOverflow: Array.from(lightOverflow.u),
      scope: "isolated actual-owner estimator; Renderer activation belongs to SCGI-8"
    };
  } catch (error) {
    console.error("SCGI estimator original failure", String(error), error.stack);
    if (pending && !pending.closed) pending.abort(error);
    throw error;
  } finally {
    await device.queue.onSubmittedWorkDone();
    estimator?.destroy();
    for (const owner of retained) owner.destroy();
    physical?.destroy();
    querySet?.destroy();
    timestampBuffer?.destroy();
    if (query?.valid) await query.releaseAfter(Promise.resolve());
    else query?.destroy();
    runtime.destroy();
    native?.destroy();
    lights.destroy();
    products.destroy();
    scene.destroy();
    graphics.appearance_programs.destroy();
    graphics.buffer_allocator_main.destroy();
    graphics.buffer_allocator_staging.destroy();
  }
}
