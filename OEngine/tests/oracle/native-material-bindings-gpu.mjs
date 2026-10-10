import { TextureResidency } from "../../.test-dist/gpu/TextureResidency.js";
import { AppearanceStaticResidency } from "../../.test-dist/gpu/AppearanceStaticResidency.js";
import { NativeMaterialProducts } from "../../.test-dist/gpu/NativeMaterialProducts.js";
import { AppearanceProgramRegistry } from "../../.test-dist/gpu/AppearanceProgramRegistry.js";
import { GpuNativeMaterialPublication } from "../../.test-dist/gpu/GpuNativeMaterialPublication.js";
import {
  createNativeMaterialBindings,
  createNativeCoverageBindings,
  nativeMaterialCoverageProgram,
} from "../../.test-dist/gpu/NativeMaterialBindings.js";
import { ShadeGPUCommandContext } from "../../.test-dist/framegraph/ShadeGPUCommandContext.js";
import { GPUBufferAllocator } from "../../.test-dist/gpu/GPUBufferAllocator.js";
import { GPUStagingBufferAllocator } from "../../.test-dist/gpu/GPUStagingBufferAllocator.js";
import { GPUTextureAllocator } from "../../.test-dist/gpu/GPUTextureAllocator.js";
import { GPUSamplerCache } from "../../.test-dist/gpu/GPUSamplerCache.js";
import { FrameProfiler } from "../../.test-dist/debug/FrameProfiler.js";
import { ShadeTexture } from "../../.test-dist/texture/ShadeTexture.js";
import { StandardShadeMaterial } from "../../.test-dist/material/StandardShadeMaterial.js";
import { compileCanonicalMaterial } from "../../.test-dist/material/CanonicalMaterial.js";
import { ShadeTransparencyMode } from "../../.test-dist/material/enums.js";
import {
  AppearanceGraphBuilder,
  snapshotAppearanceTexture,
} from "../../.test-dist/material/AppearanceGraph.js";
import { compileAppearanceGraph } from "../../.test-dist/material/AppearanceGraphCompiler.js";
import { bindAppearanceProducts } from "../../.test-dist/material/AppearanceProductBinding.js";
import {
  cookAppearanceMipProduct,
  sampleAppearanceCookedField,
} from "../../.test-dist/material/AppearanceMipCooker.js";
import { cookAppearanceNormalProduct } from "../../.test-dist/material/AppearanceNormalCooker.js";
import {
  writeAppearanceAssetPackage,
  openAppearanceAssetPackage,
} from "../../.test-dist/assets/AppearanceAssetPackage.js";
import { fixtureTexture } from "./texture-fixture.mjs";
import {
  lowerNativeMaterial,
  nativeMaterialDynamicInputs,
} from "../../.test-dist/shaders/native_material.js";

const check = (value, message) => {
  if (!value) throw new Error(message);
};
const budget = 0.0001;

/** Shared, concrete residency fixture for the isolated material and Surface oracles.
 * Graphics allocators/sampler cache stay with the caller. No private submit besides
 * the fixture's explicit upload transaction; runtime paths do not use this function. */
export async function createNativeMaterialBindingFixture(
  device,
  graphics,
  { variant = 0, physicalBindingSetBase = 0, packedProducts = false } = {},
) {
  const mips = Array.from({ length: 9 }, (_, level) => {
    const size = Math.max(1, 256 >> level);
    const payload = new Uint8Array(size * size * 4);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        payload.set(
          [variant ? 192 : 128, variant ? 96 : 64, 32, level >= 6 ? 160 : x < size / 2 ? 255 : 64],
          (y * size + x) * 4,
        );
      }
    }
    return {
      level,
      logicalWidth: size,
      logicalHeight: size,
      physicalWidth: size,
      physicalHeight: size,
      payload,
    };
  });
  const texture = await fixtureTexture("base-color-srgb", mips, true);
  const linearTexture = async (semantic, texel) => {
    const mips = Array.from({ length: 9 }, (_, level) => {
      const size = Math.max(1, 256 >> level);
      const payload = new Uint8Array(size * size * 4);
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          payload.set(texel(x, y, size, level), (y * size + x) * 4);
        }
      }
      return {
        level,
        logicalWidth: size,
        logicalHeight: size,
        physicalWidth: size,
        physicalHeight: size,
        payload,
      };
    });
    return fixtureTexture(semantic, mips);
  };
  const normalTexture = await linearTexture("normal-linear", (x, _y, size) => [
    x < size / 2 ? 144 : 112,
    128,
    253,
    255,
  ]);
  const ormTexture = await linearTexture("orm-linear", (x, _y, size) => [
    255,
    x < size / 2 ? 153 : 204,
    variant ? 102 : 51,
    255,
  ]);
  const materials = Array.from({ length: 4 }, () => {
    const material = new StandardShadeMaterial();
    material.texture_albedo = texture;
    material.roughness_factor = 0.6;
    material.metallic_factor = 0.2;
    return material;
  });
  materials[1].clearcoat_factor = 0.5;
  materials[1].clearcoat_roughness_factor = 0.3;
  materials[1].transparency_mode = ShadeTransparencyMode.AlphaTested;
  materials[1].texture_clearcoat_normal = normalTexture;
  materials[2].is_unlit = true;
  for (const material of materials.slice(0, 2)) {
    material.texture_normal = normalTexture;
    material.texture_orm = ormTexture;
  }
  const residency = new TextureResidency(graphics);
  let packedOwner;
  try {
    const command = ShadeGPUCommandContext.create(graphics, "Renderer/visibility-frame");
    const stage = residency.stage(materials, command);
    command.finish();
    await command.gpuDone;
    const material = materials[0];
    const commonFor = (material) => ({
      bindingSet: stage.bindings.bindingSets.find(
        (set) => set.id === stage.materialBindingSetIds.get(material),
      ),
      textureRoutingRefs: stage.materialTextureRoutingRefs.get(material),
      textureMipRanges: stage.textureMipRanges,
      texturePublications: stage.surfacePublications,
      obtainSampler: (descriptor) => graphics.samplers.obtain(descriptor),
    });
    const custom = new AppearanceGraphBuilder();
    const customUv = custom.input("uv0", 2, "surface", undefined, "uv0");
    const wave = custom.operation(
      "sin",
      custom.operation("multiply", customUv, custom.parameter("frequency", 3)),
    );
    const warped = custom.operation(
      "add",
      customUv,
      custom.operation("multiply", wave, custom.constant(0.03)),
    );
    const customSample = custom.texture(snapshotAppearanceTexture(texture, "srgb-rgb"), warped);
    custom.output(
      "baseColor",
      custom.operation("multiply", custom.swizzle(customSample, [0, 1, 2]), custom.parameter("gain", 0.7)),
    );
    custom.output("alpha", custom.swizzle(customSample, [3]));
    custom.output("normalTS", custom.constant([0, 0, 1]));
    custom.output(
      "roughness",
      packedProducts
        ? custom.operation(
            "add",
            custom.constant(0.45),
            custom.operation("multiply", custom.swizzle(customUv, [0]), custom.constant(0.00001)),
          )
        : custom.constant(0.45),
    );
    custom.output("metallic", custom.constant(0.1));
    custom.output("occlusion", custom.constant(1));
    custom.output("emissive", custom.constant([0, 0, 0]));
    custom.output("ior", custom.constant(1.5));
    custom.output("specularWeight", custom.constant(1));
    custom.output("specularColor", custom.constant([1, 1, 1]));
    const canonical = materials.map((material) => compileCanonicalMaterial(material));
    const compiledGraphs = [
      ...canonical.slice(0, 3).map((entry) => entry.appearance),
      compileAppearanceGraph(custom.build()),
    ];
    if (packedProducts) {
      const original = compiledGraphs[3];
      const product = cookAppearanceMipProduct(
        original,
        { roughness: original.outputs.roughness },
        {
          width: 7,
          height: 5,
          mipCount: 3,
          byteBudget: 65536,
          validationProbeBudget: 65536,
          domainMin: [0, 0],
          domainMax: [1, 1],
          coordinateDomain: "uv0",
          error: { absolute: 0.0001, relative: 0 },
          storagePrecision: "float16",
          sample: () => [],
        },
      );
      const asset = await openAppearanceAssetPackage(
        await writeAppearanceAssetPackage(product, {
          uri: "fixture://native-surface-cooked-roughness",
          contentHash: "c".repeat(64),
          dependencies: [],
        }),
      );
      compiledGraphs[3] = bindAppearanceProducts(original, [
        { source: original, asset, roots: { roughness: original.outputs.roughness } },
      ]);
      const upload = ShadeGPUCommandContext.create(graphics, "Renderer/visibility-frame");
      packedOwner = new NativeMaterialProducts(device, [compiledGraphs[3]], upload);
      upload.finish();
      await upload.gpuDone;
    }
    const bindings = compiledGraphs.map((graph, index) =>
      createNativeMaterialBindings({
        ...commonFor(materials[index]),
        graph,
        program: lowerNativeMaterial(graph),
        ...(packedOwner ? { packedProducts: packedOwner } : {}),
      }),
    );
    const coverageBindings = compiledGraphs.map((graph, index) =>
      materials[index].transparency_mode === ShadeTransparencyMode.AlphaTested
        ? createNativeCoverageBindings({ ...commonFor(materials[index]), graph, program: lowerNativeMaterial(graph), ...(packedOwner ? { packedProducts: packedOwner } : {}) }) : null);
    const sources = bindings.map((binding, materialSlot) => ({
      materialSlot,
      material: materials[materialSlot],
      family: canonical[materialSlot].family,
      // Only the isolated harness may merge independently-owned physical sets into this namespace.
      bindingSet: physicalBindingSetBase + stage.materialBindingSetIds.get(materials[materialSlot]),
      compiledGraph: compiledGraphs[materialSlot],
      program: binding.program,
      bindings: binding,
      ...(coverageBindings[materialSlot] ? { coverage: { program: coverageBindings[materialSlot].program, layoutEntries: coverageBindings[materialSlot].layoutEntries, materialEntries: coverageBindings[materialSlot].entries } } : {}),
      raster: {
        alphaCutoff: materials[materialSlot].alpha_cutoff,
        alphaMask: materials[materialSlot].transparency_mode === ShadeTransparencyMode.AlphaTested,
        hasEmissiveTexture: materials[materialSlot].texture_emissive !== undefined,
      },
    }));
    const builder = new AppearanceGraphBuilder();
    const uv = builder.input("uv0", 2, "surface", undefined, "uv0");
    const sampled = builder.texture(snapshotAppearanceTexture(texture, "srgb-rgb"), uv);
    builder.output(
      "alpha",
      builder.operation(
        "multiply",
        builder.swizzle(sampled, [3]),
        builder.input("gain", 1, "dynamic", { low: 0, high: 2 }),
      ),
    );
    builder.output("color", builder.swizzle(sampled, [0, 1, 2]));
    return {
      residency,
      stage,
      texture,
      normalTexture,
      ormTexture,
      material,
      materials,
      common: commonFor(material),
      commonFor,
      packedOwner,
      graph: compileAppearanceGraph(builder.build()),
      compiledGraphs,
      bindings,
      sources,
      resources: stage.bindings,
      destroy: () => {
        packedOwner?.destroy();
        residency.destroy();
      },
    };
  } catch (error) {
    packedOwner?.destroy();
    residency.destroy();
    throw error;
  }
}

/** True residency products -> native callbacks -> GPU values. No Surface/Tape owner,
 * prefilled closure, or hand-written replacement for the binding helper. Geometry is
 * intentionally a CXY fixture; this does not validate winner reconstruction or S1. */
export async function runNativeMaterialBindingsGpuOracle(device) {
  const graphics = {
    device,
    profiler: new FrameProfiler({ enabled: false }),
    buffer_allocator_main: new GPUBufferAllocator(device),
    buffer_allocator_staging: new GPUStagingBufferAllocator(device),
    allocator_textures: new GPUTextureAllocator(device),
    samplers: new GPUSamplerCache(device),
    textures: {
      mipmaps: {
        flush() {},
        generateMipmap() {
          throw new Error("Expected cooked mips");
        },
      },
    },
  };
  const registry = new AppearanceProgramRegistry(device);
  let fixture;
  const staticResidency = new AppearanceStaticResidency(device, registry);
  const retained = [];
  const publications = [];
  const leases = [];
  const makeBuffer = (data, usage) => {
    const buffer = device.createBuffer({ size: Math.max(data.byteLength, 4), usage, mappedAtCreation: true });
    new Uint8Array(buffer.getMappedRange()).set(
      new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
    );
    buffer.unmap();
    retained.push(buffer);
    return buffer;
  };
  const run = async (bindings, inputValues, referenceSource = "", referenceEntries = []) => {
    const program = bindings.program;
    const input = makeBuffer(inputValues, GPUBufferUsage.STORAGE);
    const size = program.outputCount * 8 * 4;
    const output = device.createBuffer({ size, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
    const readback = device.createBuffer({ size, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    retained.push(output, readback);
    const source = /* wgsl */ `
@group(0) @binding(0) var<storage, read> constants: array<f32>;
@group(0) @binding(1) var<storage, read> input_data: array<NativeMaterialInputs>;
@group(0) @binding(2) var<storage, read_write> output_data: array<f32>;
fn native_material_constant(base: u32, slot: u32) -> f32 { return constants[base + slot]; }
${program.source}
${referenceSource}
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3u) {
  if id.x >= 8u { return; }
  let result = native_material_evaluate(0u, input_data[id.x]);
  ${referenceSource ? "let expected = independent_reference(input_data[id.x]);" : ""}
  for (var channel = 0u; channel < ${program.outputCount}u; channel++) {
    output_data[id.x * ${program.outputCount}u + channel] = ${referenceSource ? "result[channel] - expected[channel]" : "result[channel]"};
  }
}`;
    const groups = [
      [0, 1, 2].map((binding) => ({
        binding,
        visibility: GPUShaderStage.COMPUTE,
        buffer: { type: binding === 2 ? "storage" : "read-only-storage" },
      })),
      referenceEntries.map((entry) => ({
        binding: entry.binding,
        visibility: GPUShaderStage.COMPUTE,
        ...(entry.sampler
          ? { sampler: { type: "filtering" } }
          : { texture: { sampleType: "float", viewDimension: "2d-array" } }),
      })),
      [],
      bindings.layoutEntries,
    ];
    const descriptor = { source, entryPoint: "main", workgroupSize: 64, groups };
    const publication = new GpuNativeMaterialPublication(device, registry, [
      { materialSlot: 0, bindingSet: bindings.group, program, descriptor },
    ]);
    publications.push(publication);
    await publication.ready;
    publication.commit();
    const { pipeline, layouts } = publication.pipeline(0);
    const ownerGroup = device.createBindGroup({
      layout: layouts[0],
      entries: [publication.constants, input, output].map((buffer, binding) => ({
        binding,
        resource: { buffer },
      })),
    });
    const referenceGroup = device.createBindGroup({
      layout: layouts[1],
      entries: referenceEntries.map(({ binding, resource }) => ({ binding, resource })),
    });
    const emptyGroup = device.createBindGroup({ layout: layouts[2], entries: [] });
    const textures = device.createBindGroup({ layout: layouts[3], entries: bindings.entries });
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, ownerGroup);
    pass.setBindGroup(1, referenceGroup);
    pass.setBindGroup(2, emptyGroup);
    pass.setBindGroup(3, textures);
    pass.dispatchWorkgroups(1);
    pass.end();
    encoder.copyBufferToBuffer(output, 0, readback, 0, size);
    device.queue.submit([encoder.finish()]);
    await readback.mapAsync(GPUMapMode.READ);
    const result = new Float32Array(readback.getMappedRange()).slice();
    readback.unmap();
    await publication.retire(device.queue.onSubmittedWorkDone());
    return result;
  };
  try {
    fixture = await createNativeMaterialBindingFixture(device, graphics);
    const { residency, stage, texture, graph, common } = fixture;
    const makeInputs = (program, gain = 0.75) => {
      const slots = Math.max(program.inputCount, 1);
      const inputs = new Float32Array(8 * slots * 12);
      for (let lane = 0; lane < 8; lane++) {
        const dynamic = nativeMaterialDynamicInputs(
          program,
          program.inputs.some((input) => input.domain === "dynamic") ? { gain: [gain] } : {},
        );
        for (let point = 0; point < 3; point++) {
          inputs.set(dynamic, lane * slots * 12 + point * slots * 4);
          program.inputs.forEach((input, slot) => {
            if (input.domain !== "dynamic") {
              inputs.set(
                [lane % 2 ? 0.75 : 0.25, 0.5, 0, 0],
                lane * slots * 12 + point * slots * 4 + slot * 4,
              );
            }
          });
        }
      }
      return inputs;
    };
    const native = lowerNativeMaterial(graph);
    const tail = createNativeMaterialBindings({ ...common, graph, program: native });
    const tailValues = await run(tail, makeInputs(native));
    const alphaSlot = native.outputs.alpha[0];
    for (let lane = 0; lane < 8; lane++) {
      check(
        Math.abs(tailValues[lane * native.outputCount + alphaSlot] - (lane % 2 ? 64 / 255 : 1) * 0.75) <
          budget,
        "Native route did not respect actual minimum resident mip",
      );
    }
    const aborted = ShadeGPUCommandContext.create(graphics, "Renderer/visibility-frame");
    residency.promote(fixture.materials, aborted, 0);
    aborted.abort(new Error("controlled native promotion abort"));
    check(
      stage.surfacePublications.get(fixture.normalTexture).currentMinimumMip === 6,
      "Abort changed native route residency",
    );
    const promotion = ShadeGPUCommandContext.create(graphics, "Renderer/visibility-frame");
    residency.promote(fixture.materials, promotion, 0);
    promotion.finish();
    await promotion.gpuDone;
    const fine = createNativeMaterialBindings({ ...common, graph, program: native });
    check(tail.program.key === fine.program.key, "Mip promotion changed native topology");
    check(
      tail.program.resourceRevision === fine.program.resourceRevision,
      "Unrelated color/normal promotion invalidated exact coverage values",
    );
    const fineValues = await run(fine, makeInputs(native));
    const coverageGraph = nativeMaterialCoverageProgram(graph);
    const coverage = createNativeMaterialBindings({
      ...common,
      graph: coverageGraph,
      program: lowerNativeMaterial(coverageGraph),
    });
    const coverageValues = await run(coverage, makeInputs(coverage.program));
    for (let lane = 0; lane < 8; lane++) {
      const expected = (lane % 2 ? 64 / 255 : 1) * 0.75;
      check(
        Math.abs(fineValues[lane * native.outputCount + alphaSlot] - expected) < budget,
        "Native fine alpha mismatch",
      );
      check(Math.abs(coverageValues[lane] - expected) < budget, "Native coverage and shading alpha disagree");
    }
    const productBuilder = new AppearanceGraphBuilder();
    const productUv = productBuilder.input("uv0", 2, "surface", undefined, "uv0");
    const u = productBuilder.swizzle(productUv, [0]);
    productBuilder.output("scalar", productBuilder.operation("multiply", u, productBuilder.constant(0.0001)));
    productBuilder.output(
      "normalTS",
      productBuilder.combine(
        productBuilder.operation("multiply", u, productBuilder.constant(0.2)),
        productBuilder.constant(0),
        productBuilder.constant(1),
      ),
    );
    productBuilder.output("roughness", productBuilder.constant(0.5));
    const original = compileAppearanceGraph(productBuilder.build());
    const options = {
      width: 4,
      height: 4,
      mipCount: 3,
      byteBudget: 65536,
      validationProbeBudget: 65536,
      domainMin: [-1, -2],
      domainMax: [2, 4],
      coordinateDomain: "uv0",
      error: { absolute: 0.001, relative: 0 },
      storagePrecision: "float16",
      sample: () => [],
    };
    const plainProduct = cookAppearanceMipProduct(original, { scalar: original.outputs.scalar }, options);
    const normalProduct = cookAppearanceNormalProduct(
      original,
      [
        {
          momentField: "baseMoment",
          normalOutput: "normalTS",
          roughnessOutput: "roughness",
          normal: original.outputs.normalTS,
          roughness: original.outputs.roughness,
          maxAngleRadians: 0.01,
          maxRoughnessError: 0.025,
        },
      ],
      options,
    );
    const pack = async (product) =>
      openAppearanceAssetPackage(
        await writeAppearanceAssetPackage(product, {
          uri: "fixture://native-product",
          contentHash: "b".repeat(64),
          dependencies: [],
        }),
      );
    const plainAsset = await pack(plainProduct),
      normalAsset = await pack(normalProduct);
    const productGraph = bindAppearanceProducts(original, [
      { source: original, asset: plainAsset, roots: { scalar: original.outputs.scalar } },
      { source: original, asset: normalAsset },
    ]);
    const command = ShadeGPUCommandContext.create(graphics, "Renderer/visibility-frame");
    const plainLease = staticResidency.acquire(plainAsset, command),
      normalLease = staticResidency.acquire(normalAsset, command);
    leases.push(plainLease, normalLease);
    command.finish();
    await command.gpuDone;
    const productNative = lowerNativeMaterial(productGraph);
    const products = createNativeMaterialBindings({
      ...common,
      graph: productGraph,
      program: productNative,
      products: new Map([
        [plainLease.assetId, plainLease],
        [normalLease.assetId, normalLease],
      ]),
    });
    const scalar = plainLease.destination("scalar"),
      moment = normalLease.destination("baseMoment");
    const referenceSource = /* wgsl */ `
@group(1) @binding(0) var independent_scalar: texture_2d_array<f32>;
@group(1) @binding(1) var independent_moment: texture_2d_array<f32>;
@group(1) @binding(2) var independent_sampler: sampler;
fn independent_reference(inputs: NativeMaterialInputs) -> array<f32, ${productNative.outputCount}> {
  let coordinate = (inputs.center[0].xy + vec2f(1.0, 2.0)) / vec2f(3.0, 6.0);
  let dx = (inputs.x[0].xy - inputs.center[0].xy) / vec2f(3.0, 6.0);
  let dy = (inputs.y[0].xy - inputs.center[0].xy) / vec2f(3.0, 6.0);
  let scalar = textureSampleGrad(independent_scalar, independent_sampler, coordinate, ${scalar.layer}, dx, dy).r;
  let moment = textureSampleGrad(independent_moment, independent_sampler, coordinate, ${moment.layer}, dx, dy).xyz;
  let squared_length = dot(moment, moment);
  let normal = moment / sqrt(squared_length);
  let bounded = min(squared_length, 1.0);
  let inverse_concentration = (1.0 - bounded) / (sqrt(bounded) * (3.0 - bounded));
  let roughness = pow(min(2.0 * inverse_concentration, 1.0), 0.25);
  return array<f32, ${productNative.outputCount}>(scalar, normal.x, normal.y, normal.z, roughness, 1.0);
}`;
    const productInputs = makeInputs(productNative);
    for (let lane = 0; lane < 8; lane++) {
      const stride = productNative.inputCount * 4;
      // Full gradients, fractional/integer mip footprints and non-unit authored domain.
      const step = [0, 0.2, 1, 3][lane % 4];
      productInputs[lane * stride * 3 + stride] += step;
      productInputs[lane * stride * 3 + stride * 2 + 1] += step * 0.7;
    }
    const residuals = await run(products, productInputs, referenceSource, [
      { binding: 0, resource: scalar.texture.createView({ dimension: "2d-array" }) },
      { binding: 1, resource: moment.texture.createView({ dimension: "2d-array" }) },
      {
        binding: 2,
        sampler: true,
        resource: graphics.samplers.obtain({
          minFilter: "linear",
          magFilter: "linear",
          mipmapFilter: "linear",
          addressModeU: "clamp-to-edge",
          addressModeV: "clamp-to-edge",
        }),
      },
    ]);
    const maxProductError = Math.max(...residuals.map(Math.abs));
    check(
      Number.isFinite(maxProductError) && maxProductError < budget,
      "Native Product/normal decode differs from independent hardware reference",
    );
    // A genuinely wider legal graph: twenty differently sized cooked fields.
    // Its hardware layout exceeds the portable 16-texture stage profile. The
    // packed representation must retain all twenty queries and every original mip.
    const wideBuilder = new AppearanceGraphBuilder();
    const wideUv = wideBuilder.input("uv0", 2, "surface", undefined, "uv0");
    const wideU = wideBuilder.swizzle(wideUv, [0]);
    for (let i = 0; i < 20; i++) {
      wideBuilder.output(
        `field${i}`,
        wideBuilder.operation("multiply", wideU, wideBuilder.constant((i + 1) * 0.0001)),
      );
    }
    const wideOriginal = compileAppearanceGraph(wideBuilder.build());
    const wideAssets = [],
      wideCooked = [],
      wideMappings = [];
    for (let i = 0; i < 20; i++) {
      const name = `field${i}`;
      const product = cookAppearanceMipProduct(
        wideOriginal,
        { [name]: wideOriginal.outputs[name] },
        { ...options, width: 4 + i },
      );
      const asset = await pack(product);
      wideCooked.push(product.fields[name]);
      wideAssets.push(asset);
      wideMappings.push({ source: wideOriginal, asset, roots: { [name]: wideOriginal.outputs[name] } });
    }
    const wideGraph = bindAppearanceProducts(wideOriginal, wideMappings);
    const packedUpload = ShadeGPUCommandContext.create(graphics, "Renderer/visibility-frame");
    const packedOwner = new NativeMaterialProducts(device, [wideGraph], packedUpload);
    retained.push(packedOwner);
    packedUpload.finish();
    await packedUpload.gpuDone;
    const wideNative = lowerNativeMaterial(wideGraph);
    const wideBinding = createNativeMaterialBindings({
      ...common,
      graph: wideGraph,
      program: wideNative,
      packedProducts: packedOwner,
    });
    check(
      wideBinding.productTextureCount === 1 && wideBinding.layoutEntries.length === 1,
      "Wide Products created one binding per field",
    );
    const wideInputs = makeInputs(wideNative);
    for (let lane = 0; lane < 8; lane++) {
      const stride = wideNative.inputCount * 4;
      const step = [0, 0.2, 1, 3][lane % 4];
      wideInputs[lane * stride * 3 + stride] += step;
      wideInputs[lane * stride * 3 + stride * 2 + 1] += step * 0.7;
    }
    const wideValues = await run(wideBinding, wideInputs);
    let maxPackedProductError = 0;
    for (let lane = 0; lane < 8; lane++) {
      for (let i = 0; i < 20; i++) {
        const width = 4 + i;
        const first = lane * wideNative.inputCount * 12;
        const u = (wideInputs[first] + 1) / 3;
        const v = (wideInputs[first + 1] + 2) / 6;
        const dx = ((wideInputs[first + wideNative.inputCount * 4] - wideInputs[first]) / 3) * width;
        const dy = ((wideInputs[first + wideNative.inputCount * 8 + 1] - wideInputs[first + 1]) / 6) * 4;
        const lod = Math.max(0, Math.min(2, Math.log2(Math.max(Math.abs(dx), Math.abs(dy), 1e-20))));
        const expected = sampleAppearanceCookedField(wideCooked[i], u, v, lod)[0];
        const actual = wideValues[lane * wideNative.outputCount + wideNative.outputs[`field${i}`][0]];
        maxPackedProductError = Math.max(maxPackedProductError, Math.abs(expected - actual));
      }
    }
    check(
      maxPackedProductError < budget,
      "Packed native Product sampling differs from cooked CPU field oracle",
    );
    return {
      status: "passed",
      actualTextureResidency: true,
      actualStaticResidency: true,
      minMipTail: 6,
      promotedMinMip: 0,
      abortedPromotion: "retained tail",
      coverageAlpha: "matches native shading",
      productTextureCount: products.productTextureCount,
      maxProductError,
      packedProducts: {
        fields: 20,
        textureBindings: 1,
        payloadBytes: packedOwner.payloadBytes,
        physicalBytes: packedOwner.physicalBytes,
        maxAbsoluteError: maxPackedProductError,
        reference: "CPU cooked-field evaluator, actual half payload, original dimensions/mips/domain",
      },
      tolerance: budget,
      scope: "native binding/publication component, fixture CXY; no winner/Surface/production adoption",
    };
  } finally {
    await device.queue.onSubmittedWorkDone();
    registry.destroy();
    leases.forEach((lease) => lease.release());
    staticResidency.destroy();
    fixture?.destroy();
    retained.forEach((resource) => resource.destroy());
    graphics.buffer_allocator_main.destroy();
    graphics.buffer_allocator_staging.destroy();
    graphics.allocator_textures.destroy();
  }
}
