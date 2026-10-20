import assert from "node:assert/strict";
import { GpuScene } from "../../.test-dist/gpu/GpuScene.js";
import { GeometryProductMultiRuntimeV1 } from "../../.test-dist/gpu/GeometryProductMultiRuntime.js";
import { GpuNativeMaterialScene } from "../../.test-dist/gpu/GpuNativeMaterialScene.js";
import { TextureResidency } from "../../.test-dist/gpu/TextureResidency.js";
import { AppearanceProgramRegistry } from "../../.test-dist/gpu/AppearanceProgramRegistry.js";
import {
  ShaderModuleCache,
  PipelineLayoutCache,
  RenderPipelineCache,
} from "../../.test-dist/gpu/GPUDescriptorCaches.js";
import { GPUSamplerCache } from "../../.test-dist/gpu/GPUSamplerCache.js";
import { StandardShadeMaterial } from "../../.test-dist/material/StandardShadeMaterial.js";
import {
  AppearanceGraphBuilder,
  snapshotAppearanceTexture,
} from "../../.test-dist/material/AppearanceGraph.js";
import { compileAppearanceGraph } from "../../.test-dist/material/AppearanceGraphCompiler.js";
import { ShadeTexture } from "../../.test-dist/texture/ShadeTexture.js";
import { ScgiQueryScene } from "../../.test-dist/render/gi/ScgiQueryScene.js";
import { ScgiQueryBatch } from "../../.test-dist/render/gi/ScgiQueryBatch.js";
import { ScgiQueryTraversal } from "../../.test-dist/render/gi/ScgiQueryTraversal.js";
import { ScgiQueryHitWork } from "../../.test-dist/render/gi/ScgiQueryHitWork.js";
import { createNativeMaterialBindings } from "../../.test-dist/gpu/NativeMaterialBindings.js";
import { encodeGpuTextureRef } from "../../.test-dist/gpu/GpuTextureRefAbi.js";
import { lowerNativeMaterial } from "../../.test-dist/shaders/native_material.js";
import { triangleProductFixture } from "../helpers/geometry-product-fixture.mjs";
import { scgiGraphics, scgiCommand } from "./scgi-fixture.mjs";
import { sourceFixture } from "./streaming-vt-gpu.mjs";

const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const tick = () => new Promise((resolve) => setTimeout(resolve, 1));

/** Exercise the query consumer's complete legal sampled union, independently
 * of the raster producer's smaller lighting-reserved bank profile. All samples
 * affect the numeric output. Resources are real textures and Native bindings,
 * and geometry/instances still come from the existing immutable query scene. */
async function checkFullDescriptors(device, graphics, scene, batch, output, tiled, publication) {
  const textures = [];
  let work;
  let query;
  const read = device.createBuffer({ size: 64, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
  try {
    assert.equal(
      device.limits.maxSampledTexturesPerShaderStage,
      16,
      "fixture targets the negotiated 16-texture route",
    );
    const graph = new AppearanceGraphBuilder();
    const uv = graph.input("uv0", 2, "surface", undefined, "uv0");
    const refs = new Map();
    const publications = new Map();
    const views = [];
    let sum = graph.constant(0);
    const add = (texture) => {
      const sample = graph.texture(snapshotAppearanceTexture(texture, "linear-rgb"), uv);
      sum = graph.operation("add", sum, graph.swizzle(sample, [0]));
    };
    // Six ordinary RGB sampler classes: three wrap modes x nearest/linear.
    for (let index = 0; index < 14; index++) {
      const texture = new ShadeTexture();
      texture.wrapS = texture.wrapT = index % 3;
      texture.minFilter = texture.magFilter = Math.floor(index / 3) % 2;
      const gpu = device.createTexture({
        size: [1, 1, 2],
        format: "rgba8unorm",
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      });
      textures.push(gpu);
      device.queue.writeTexture(
        { texture: gpu, origin: [0, 0, 1] },
        new Uint8Array([64, 64, 64, 255]),
        {},
        [1, 1, 1],
      );
      views.push(gpu.createView({ dimension: "2d-array" }));
      refs.set(texture, encodeGpuTextureRef(index, 1));
      add(texture);
    }
    // Both VT sampler classes share the existing table/atlas: 14+2 textures,
    // and six ordinary + two VT samplers is the RGB Native route maximum.
    for (const filter of [0, 1]) {
      const texture = ShadeTexture.fromTiled(tiled);
      texture.minFilter = texture.magFilter = filter;
      publications.set(texture, publication);
      add(texture);
    }
    graph.output("baseColor", graph.swizzle(graph.operation("divide", sum, graph.constant(16)), [0, 0, 0]));
    const compiled = compileAppearanceGraph(graph.build());
    const binding = createNativeMaterialBindings({
      graph: compiled,
      program: lowerNativeMaterial(compiled),
      bindingSet: {
        id: 1,
        generation: 1,
        textureBanks: views,
        bankDescriptors: views.map((_, segment) => ({ segment })),
      },
      textureRoutingRefs: refs,
      textureMipRanges: new Map(),
      texturePublications: publications,
      obtainSampler: (descriptor) => graphics.samplers.obtain(descriptor),
    });
    work = await ScgiQueryHitWork.create(
      device,
      scene.sourceInstances.sourceSnapshot,
      scene.materials.directory,
      batch,
      1,
      48,
      1,
    );
    const arena = scene.arenas[0];
    query = await ScgiQueryTraversal.create(device, {
      arena,
      route: { ...arena.routes[0], sourceGroup: 0 },
      source: scene.sourceInstances.sourceSnapshot,
      instances: scene.instanceRecords,
      work,
      batch,
      rayCount: 1,
      resultByteOffset: 48,
      coverageStatus: scene.coverageStatus,
      diffuse: {
        material: {
          materialSlot: 0,
          binding,
          constants: Float32Array.from(binding.program.constants),
          unlit: false,
        },
        directory: scene.materials.directory,
        binIndex: 0,
        output,
        feedback: scene.virtualTextures.queryFeedbackBuffers[0],
        view: identity,
        camera: [0, 0, 1],
        coneWidth: 0.00001,
        coneSpread: 0,
      },
    });
    assert.equal(query.descriptors.storage, 16);
    assert.equal(query.descriptors.sampled, 16);
    assert.equal(query.descriptors.sampler, 8);
    const command = scgiCommand(graphics);
    scene.observeUse(command);
    work.encode(command);
    query.encode(command);
    command.copyBufferToBuffer(output, 0, read, 0, 64);
    command.finish();
    await command.gpuDone;
    await read.mapAsync(GPUMapMode.READ);
    const actual = new Float32Array(read.getMappedRange().slice(0));
    read.unmap();
    const expected = ((14 * 64) / 255 + (2 * 224) / 255) / 16 / Math.PI;
    assert.ok(
      Math.abs(actual[0] - expected) < 2e-5,
      `complete native sampled union: ${actual[0]} vs ${expected}`,
    );
    assert.equal(actual[11], 1);
    return { descriptors: query.descriptors, expected, actual: actual[0] };
  } finally {
    await device.queue.onSubmittedWorkDone();
    query?.destroy();
    work?.destroy();
    read.destroy();
    for (const texture of textures) texture.destroy();
  }
}

/** Real Native projection + existing VT atlas/IO. Constant BC4 blocks provide
 * independent tail/fine values; no substitute sampler or injected feedback. */
export async function runScgiQueryVtGpuOracle(device) {
  const graphics = scgiGraphics(device);
  graphics.appearance_programs = new AppearanceProgramRegistry(device);
  graphics.samplers = new GPUSamplerCache(device);
  graphics.render_pipelines = new RenderPipelineCache(
    device,
    new PipelineLayoutCache(device),
    new ShaderModuleCache(device),
  );
  const textures = (graphics.texture_residency = new TextureResidency(graphics));
  const scene = new GpuScene(device, {});
  const products = new GeometryProductMultiRuntimeV1(device);
  const buffers = [],
    candidates = [],
    batches = [];
  let native;
  let upload;
  let cold;
  try {
    cold = await sourceFixture();
    const material = new StandardShadeMaterial();
    material.texture_occlusion = ShadeTexture.fromTiled(cold.source);
    const graph = new AppearanceGraphBuilder();
    const uv = graph.input("uv0", 2, "surface", undefined, "uv0");
    const sample = graph.texture(snapshotAppearanceTexture(material.texture_occlusion, "linear-rgb"), uv);
    graph.output("baseColor", graph.swizzle(sample, [0, 0, 0]));
    graph.output("alpha", graph.constant(1));
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
      coatRoughness: 0,
      coatNormalTS: [0, 0, 1],
    }))
      graph.output(name, graph.constant(value));
    material.appearance_definition = { schemaVersion: 1, graph: graph.build() };
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
          decodedPageHash128: hash,
        };
      },
      release() {},
    });
    upload = scgiCommand(graphics);
    scene.instantiate(
      {
        count: 1,
        geometryHandles: [],
        virtualGeometry: {
          productTableSlot: product.productTableSlot,
          productGeneration: product.productGeneration,
          assetCount: 1,
        },
        geometryIndices: new Uint32Array([product.assetReferenceBegin]),
        materialHandles: new Uint32Array([0]),
        currentTransforms: new Float32Array(identity),
        flags: new Uint32Array([1]),
        boundsSpheres: new Float32Array([0, 0, 0, 1]),
        boundsMin: new Float32Array([-0.5, -0.5, 0]),
        boundsMax: new Float32Array([0.5, 0.5, 0]),
      },
      upload,
    );
    const stage = textures.stage([material], upload);
    await textures.uploadTiled([material], upload);
    native = new GpuNativeMaterialScene(
      graphics,
      [
        {
          materialSlot: 0,
          material,
          graph: compileAppearanceGraph(graph.build()),
          textureBindingSetId: stage.materialBindingSetIds.get(material),
          textureRefs: stage.materialTextureRoutingRefs.get(material),
        },
      ],
      () => stage.bindings.bindingSets,
      stage.textureMipRanges,
      stage.surfacePublications,
      upload,
      true,
      false,
    );
    await native.ready;
    upload.finish();
    await upload.gpuDone;
    native.setQueryProjectionEnabled(true);
    const deadline = performance.now() + 30000;
    while (!native.canPrepareFrame()) {
      assert.ok(performance.now() < deadline, "VT native projection preparation timeout");
      await tick();
    }
    const prepare = scgiCommand(graphics);
    native.prepareFrame(prepare);
    prepare.finish();
    await prepare.gpuDone;
    const vt = textures.virtualTextures;
    const queryScene = await ScgiQueryScene.create(
      device,
      {
        deviceEpoch: 1,
        originEpoch: 0,
        primitiveCapacity: 8,
        maximumBytes: 8 * 1024 ** 2,
        subgroup: false,
      },
      { nativeMaterials: native, virtualGeometry: products },
      scene,
      [product.residency],
    );
    candidates.push(queryScene);
    const allocate = (size, usage) => {
      const buffer = device.createBuffer({ size, usage });
      buffers.push(buffer);
      return buffer;
    };
    const batch = allocate(80, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC);
    const output = allocate(64, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC);
    const read = allocate(96, GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST);
    const query = await ScgiQueryBatch.create(device, queryScene, {
      batch,
      rayCount: 1,
      resultByteOffset: 48,
      output,
      view: identity,
      camera: [0, 0, 1],
      coneWidth: 0.00001,
      coneSpread: 0,
    });
    batches.push(query);
    assert.equal(
      query.cost.descriptors.storage,
      16,
      "widest query SSBO route compiles and binds all 16 resources",
    );
    const ray = new ArrayBuffer(48);
    new Float32Array(ray).set([0, 0, 1, 0, 0, 0, -1, 10]);
    new Uint32Array(ray)[9] = 0xffffffff;
    let firstGeneration;
    const values = [];
    for (let frame = 0; frame < 25; frame++) {
      const command = scgiCommand(graphics);
      vt.prepareFrame(command, frame, "");
      vt.encodeUploads(command);
      if (frame === 0) {
        command.uploadRegions([{ destination: batch, destinationOffset: 0, bytes: new Uint8Array(ray) }]);
        queryScene.encode(command);
      }
      query.encode(command);
      vt.finishFeedback(command);
      command.copyBufferToBuffer(batch, 48, read, 0, 32);
      command.copyBufferToBuffer(output, 0, read, 32, 64);
      command.finish();
      await command.gpuDone;
      await read.mapAsync(GPUMapMode.READ);
      const data = read.getMappedRange().slice(0);
      read.unmap();
      const words = new Uint32Array(data),
        floats = new Float32Array(data);
      assert.equal(words[3], 0, "VT shading remains an accepted Product hit");
      values.push(floats[8]);
      if (frame === 0) {
        firstGeneration = query.mappingGeneration;
        assert.ok(Math.abs(floats[8] - 32 / 255 / Math.PI) < 2e-5, "independent protected-tail value");
      }
      if (query.mappingGeneration > firstGeneration && Math.abs(floats[8] - 224 / 255 / Math.PI) < 2e-5)
        break;
      await tick();
    }
    assert.ok(
      query.mappingGeneration > firstGeneration,
      "query-only feedback advances ordinary mapping publication",
    );
    assert.ok(
      Math.abs(values.at(-1) - 224 / 255 / Math.PI) < 2e-5,
      "independent fine-mip value from delayed query demand",
    );
    assert.equal(vt.evidence().demand.wanted, 0, "query demand did not enter the primary channel");
    assert.equal(cold.preparation.evidence().credit.used.ready, 0, "tile IO receipts all released");
    const fullDescriptors = await checkFullDescriptors(
      device,
      graphics,
      queryScene,
      batch,
      output,
      cold.source,
      stage.surfacePublications.get(material.texture_occlusion),
    );
    return {
      values,
      firstGeneration,
      mappingGeneration: query.mappingGeneration,
      queryOnlyRefinement: true,
      independentTailAndFine: true,
      cost: query.cost,
      fullDescriptors,
      residentPages: vt.evidence().resident,
    };
  } finally {
    if (upload && !upload.closed) upload.abort(new Error("VT query fixture preparation cancelled"));
    await device.queue.onSubmittedWorkDone();
    for (const batch of batches) batch.destroy();
    for (const candidate of candidates) {
      if (candidate.valid) await candidate.releaseAfter(Promise.resolve());
      else candidate.destroy();
    }
    native?.destroy();
    textures.destroy();
    cold?.preparation.dispose();
    products.destroy();
    scene.destroy();
    for (const buffer of buffers) buffer.destroy();
    graphics.appearance_programs.destroy();
    graphics.buffer_allocator_main.destroy();
    graphics.buffer_allocator_staging.destroy();
  }
}
