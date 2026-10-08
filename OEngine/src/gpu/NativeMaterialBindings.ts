import type { CompiledAppearanceGraph } from "../material/AppearanceGraphCompiler.js";
import { selectAppearanceProductProgram } from "../material/AppearanceGraphCompiler.js";
import type { ShadeTexture } from "../texture/ShadeTexture.js";
import { lowerNativeMaterial, type NativeMaterialProgram } from "../shaders/native_material.js";
import type { AppearanceStaticLease } from "./AppearanceStaticResidency.js";
import type { NativeMaterialProducts } from "./NativeMaterialProducts.js";
import { NATIVE_PACKED_PRODUCT_WGSL } from "../shaders/native_material_products.js";
import type { TextureBindingSet } from "./TextureResidency.js";
import type { TextureSurfacePublication } from "./TextureSurfacePublication.js";
import { encodeSamplerClass, GPU_MATERIAL_VISIBILITY_SAMPLER as S } from "./GpuMaterialVisibilityAbi.js";
import {
  decodeGpuTextureRef,
  GPU_TEXTURE_REF_INVALID,
  GPU_TEXTURE_REF_WGSL,
  GPU_TEXTURE_CLAMPED_SAMPLE_WGSL,
} from "./GpuTextureRefAbi.js";

export interface NativeMaterialBindingSource {
  readonly graph: CompiledAppearanceGraph;
  readonly program: NativeMaterialProgram;
  readonly bindingSet: TextureBindingSet;
  /** Material-local physical routes from TextureResidencyStage, not logical handles. */
  readonly textureRoutingRefs: ReadonlyMap<ShadeTexture, number>;
  readonly textureMipRanges: ReadonlyMap<ShadeTexture, readonly [number, number]>;
  readonly texturePublications: ReadonlyMap<ShadeTexture, TextureSurfacePublication>;
  /** Static residency leases indexed by assetId. Caller retains these through the last consumer fence. */
  readonly products?: ReadonlyMap<string, AppearanceStaticLease>;
  /** Exact finite physical representation when separate Product textures exceed limits. */
  readonly packedProducts?: NativeMaterialProducts;
  /** Use the owner's sampler cache; this helper only runs when preparing a publication. */
  readonly obtainSampler: (descriptor: GPUSamplerDescriptor) => GPUSampler;
  readonly group?: number;
  readonly visibility?: GPUShaderStageFlags;
  readonly sharedTextureAbi?: boolean;
}

export interface NativeMaterialBindings {
  /** Composed callbacks + evaluator. Routes are additional immutable instance constants. */
  readonly program: NativeMaterialProgram;
  readonly group: number;
  readonly layoutEntries: readonly GPUBindGroupLayoutEntry[];
  readonly entries: readonly GPUBindGroupEntry[];
  readonly bankMask: number;
  readonly productTextureCount: number;
  readonly routeConstantBytes: number;
}

/** Finite change detector for Temporal invalidation, never exact resource identity. */
export function nativeMaterialRevision(parts: readonly (string | number)[]): number {
  let hash = 2166136261;
  for (const part of parts) {
    const text = `${typeof part}:${part};`;
    for (let index = 0; index < text.length; index++) {
      hash = Math.imul(hash ^ text.charCodeAt(index), 16777619) >>> 0;
    }
  }
  return hash || 1;
}

/** Native binding glue over the existing residency contracts. No buffer, dispatch, submit,
 * resource lifetime owner, Tape, field heap or runtime interpreter is introduced.
 * Source transforms are already applied by lowerNativeMaterial. TextureResidency banks
 * already decode RGB/alpha; Product textures already contain cooked linear half values.
 * Cost: 28B/query route constants, 20B/nonconstant Product mapping, no per-pixel writes,
 * one sample per requested CXY point and the existing residency clamp/routing ALU.
 */
export function createNativeMaterialBindings(source: NativeMaterialBindingSource): NativeMaterialBindings {
  const { graph, program } = source;
  if (program.key !== lowerNativeMaterial(graph).key) {
    throw new RangeError("Native material binding graph must match the unbound native program");
  }
  const group = source.group ?? 3;
  if (!Number.isInteger(group) || group < 0) {
    throw new RangeError("Native material group must be a nonnegative integer");
  }
  const visibility = source.visibility ?? GPUShaderStage.COMPUTE;
  const constants = [...program.constants];
  const layoutEntries: GPUBindGroupLayoutEntry[] = [];
  const entries: GPUBindGroupEntry[] = [];
  const declarations: string[] = [];
  const callbacks: string[] = [];
  const resources = new Map<string | GPUTexture, number>();
  const revisions: (string | number)[] = [source.bindingSet.id, source.bindingSet.generation];
  let bankMask = 0;
  let productTextureCount = 0;
  let packedProductHelpers = "";
  const constant = (value: number): string => {
    if (!Number.isFinite(Math.fround(value))) {
      throw new RangeError("Native material route constants must be finite f32");
    }
    const slot = constants.length;
    constants.push(Math.fround(value));
    return `native_material_constant(material_base, ${slot}u)`;
  };
  const resource = (
    key: string | GPUTexture,
    name: string,
    layout: Pick<GPUBindGroupLayoutEntry, "texture" | "sampler">,
    value: () => GPUBindingResource,
    type: string,
  ): string => {
    let binding = resources.get(key);
    if (binding === undefined) {
      binding = resources.size;
      resources.set(key, binding);
      layoutEntries.push({ binding, visibility, ...layout });
      entries.push({ binding, resource: value() });
      declarations.push(
        `@group(${group}) @binding(${binding}) var native_material_resource_${binding}: ${type}; // ${name}`,
      );
    }
    return `native_material_resource_${binding}`;
  };
  graph.samples.forEach((sample, index) => {
    const binding = sample.binding;
    const reference = source.textureRoutingRefs.get(binding.texture) ?? GPU_TEXTURE_REF_INVALID;
    const decoded = decodeGpuTextureRef(reference);
    if (reference !== GPU_TEXTURE_REF_INVALID && decoded === null) {
      throw new RangeError("Native material requires a valid physical TextureResidency route");
    }
    const publication = source.texturePublications.get(binding.texture);
    const mipRange = source.textureMipRanges.get(binding.texture);
    const minimumMip = publication?.currentMinimumMip ?? mipRange?.[0];
    const samplerClass = encodeSamplerClass(
      {
        wrapS: binding.sampler[4],
        wrapT: binding.sampler[5],
        minFilter: binding.sampler[1],
        magFilter: binding.sampler[2],
        texture_product: binding.texture.texture_product,
      } as ShadeTexture,
      minimumMip === undefined ? undefined : [minimumMip, mipRange?.[1] ?? minimumMip],
    );
    // Keep TextureResidency's existing finite sampler-class policy, including
    // its admitted mixed-state default class. A native binding must not silently
    // narrow the set of material snapshots accepted by the current owner.
    revisions.push(
      binding.contentVersion ?? "unversioned",
      reference,
      samplerClass.value,
      publication?.slot ?? 0,
      publication?.generation ?? 0,
      publication?.currentRevision ?? publication?.revision ?? 0,
    );
    // Two exact u16 values avoid transporting a u32 as a lossy f32 or NaN payload.
    const low = constant(reference & 0xffff);
    const high = constant(reference >>> 16);
    const samplerValue = constant(samplerClass.value);
    const fallback = binding.fallback.map(constant);
    const bank = decoded?.bankClass ?? 0;
    bankMask |= 1 << bank;
    const coverage = publication?.coverage;
    const needsAlpha = (sample.readMask & 8) !== 0;
    const needsColor = (sample.readMask & 7) !== 0 || (needsAlpha && coverage === undefined);
    const residentTexture = (slot: number): string =>
      resource(
        `bank/${slot}`,
        `resident slot ${slot}`,
        { texture: { sampleType: "float", viewDimension: "2d-array" } },
        () => {
          const view = source.bindingSet.textureBanks[slot];
          if (!view) throw new RangeError("Native material texture slot is absent");
          return view;
        },
        "texture_2d_array<f32>",
      );
    const texture = needsColor ? residentTexture(bank) : undefined;
    const coverageSlot =
      needsAlpha && coverage
        ? source.bindingSet.bankDescriptors.findIndex((descriptor) => descriptor.segment === coverage.segment)
        : -1;
    if (needsAlpha && coverage && coverageSlot < 0)
      throw new Error("Native exact coverage plane missing from material tuple");
    const alphaTexture = coverageSlot >= 0 ? residentTexture(coverageSlot) : undefined;
    if (coverageSlot >= 0) bankMask |= 1 << coverageSlot;
    const address = samplerClass.value & S.AddressMask;
    const wrap = address === 0 ? "clamp-to-edge" : address === 2 ? "mirror-repeat" : "repeat";
    const filter = (samplerClass.value & S.LinearBit) !== 0 ? "linear" : "nearest";
    const sampler = resource(
      `sampler/${wrap}/${filter}`,
      `${wrap} ${filter}`,
      { sampler: { type: "filtering" } },
      () =>
        source.obtainSampler({
          addressModeU: wrap,
          addressModeV: wrap,
          minFilter: filter,
          magFilter: filter,
          mipmapFilter: filter,
        }),
      "sampler",
    );
    const product = binding.texture.texture_product;
    const primarySample = texture
      ? `oengine_sample_texture_clamped(${texture}, ${sampler}, reference, u32(${samplerValue}), uv, i32(oengine_texture_ref_layer(reference)), dx, dy)`
      : "vec4f(1.0)";
    let valueExpression = "oengine_texture_ref_apply_routing(reference, value)";
    if (product?.metadata.semantic === "occlusion-linear") {
      const channels = ["0.0", "0.0", "0.0", "1.0"];
      channels[product.metadata.channel] = "value.r";
      valueExpression = `vec4f(${channels.join(", ")})`;
    }
    const alphaSample = alphaTexture
      ? `let alpha = oengine_sample_texture_clamped(${alphaTexture}, ${sampler}, reference, u32(${samplerValue}), uv, i32(${constant(coverage!.layer)}), dx, dy).r;\n  return vec4f((${valueExpression}).rgb, alpha);`
      : `return ${valueExpression};`;
    callbacks.push(/* wgsl */ `
fn native_material_sample_${index}(material_base: u32, uv: vec2f, dx: vec2f, dy: vec2f) -> vec4f {
  let reference = u32(${low}) | (u32(${high}) << 16u);
  if reference == OENGINE_TEXTURE_REF_INVALID {
    return vec4f(${fallback.join(", ")});
  }
  let value = ${primarySample};
  ${alphaSample}
}`);
  });
  (graph.productReads ?? []).forEach((read, index) => {
    revisions.push(read.field.contentKey);
    if (read.field.constant !== undefined) {
      return;
    }
    if (source.packedProducts !== undefined) {
      const payload = source.packedProducts;
      const packed = payload.field(read.field);
      if (!resources.has(payload.texture)) {
        productTextureCount++;
      }
      const texture = resource(
        payload.texture,
        "exact packed cooked Products",
        { texture: { sampleType: "unfilterable-float", viewDimension: "2d-array" } },
        () => payload.view,
        "texture_2d_array<f32>",
      );
      const metadata = constants.length;
      packed.field.mips.forEach((mip, level) => {
        const offset = packed.offsets[level]!;
        constant(offset & 0xffff);
        constant(offset >>> 16);
        constant(mip.width);
        constant(mip.height);
      });
      const origin = read.asset.domainMin.map(constant);
      const scale = read.asset.domainMax.map((maximum, axis) => {
        const extent = maximum - read.asset.domainMin[axis]!;
        if (!(extent > 0)) {
          throw new RangeError("Native Product requires a positive coordinate domain");
        }
        return constant(1 / extent);
      });
      const channels = read.field.width === 3 ? 4 : read.field.width;
      packedProductHelpers = NATIVE_PACKED_PRODUCT_WGSL;
      callbacks.push(/* wgsl */ `
fn native_material_product_${index}(material_base: u32, uv: vec2f, dx: vec2f, dy: vec2f) -> vec4f {
  return native_product_sample(${texture}, material_base, ${metadata}u, ${packed.offsets.length}u, ${channels}u,
    vec2f(${origin.join(", ")}), vec2f(${scale.join(", ")}), uv, dx, dy);
}`);
      return;
    }
    const id = read.asset.runtime.manifest.assetId;
    const lease = source.products?.get(id);
    if (lease === undefined || lease.assetId !== id) {
      throw new RangeError(
        `Native material Product '${read.field.name}' requires its static residency lease`,
      );
    }
    const target = lease.destination(read.field.name);
    const base = read.field.mips[0]!;
    if (
      target.texture.format !== read.field.format ||
      target.texture.width !== base.width ||
      target.texture.height !== base.height ||
      target.texture.mipLevelCount !== read.field.mips.length ||
      !Number.isInteger(target.layer) ||
      target.layer < 0 ||
      target.layer >= target.texture.depthOrArrayLayers
    ) {
      throw new RangeError("Native material Product destination does not match the cooked field");
    }
    if (!resources.has(target.texture)) {
      productTextureCount++;
    }
    const texture = resource(
      target.texture,
      `Product ${read.field.name}`,
      { texture: { sampleType: "float", viewDimension: "2d-array" } },
      () => target.texture.createView({ dimension: "2d-array" }),
      "texture_2d_array<f32>",
    );
    const sampler = resource(
      "product-sampler",
      "cooked Product clamp linear",
      { sampler: { type: "filtering" } },
      () =>
        source.obtainSampler({
          addressModeU: "clamp-to-edge",
          addressModeV: "clamp-to-edge",
          minFilter: "linear",
          magFilter: "linear",
          mipmapFilter: "linear",
        }),
      "sampler",
    );
    const layer = constant(target.layer);
    const origin = read.asset.domainMin.map(constant);
    const scale = read.asset.domainMax.map((maximum, axis) => {
      const extent = maximum - read.asset.domainMin[axis]!;
      if (!(extent > 0)) {
        throw new RangeError("Native material Product requires a positive coordinate domain");
      }
      return constant(1 / extent);
    });
    callbacks.push(/* wgsl */ `
fn native_material_product_${index}(material_base: u32, uv: vec2f, dx: vec2f, dy: vec2f) -> vec4f {
  let origin = vec2f(${origin.join(", ")});
  let scale = vec2f(${scale.join(", ")});
  return textureSampleGrad(${texture}, ${sampler}, (uv - origin) * scale, i32(${layer}), dx * scale, dy * scale);
}`);
  });
  const sampling =
    graph.samples.length === 0
      ? ""
      : /* wgsl */ `
${source.sharedTextureAbi ? "" : GPU_TEXTURE_REF_WGSL}
const OENGINE_MATERIAL_SAMPLER_ADDRESS_MASK: u32 = ${S.AddressMask}u;
const OENGINE_MATERIAL_SAMPLER_LINEAR: u32 = ${S.LinearBit}u;
const OENGINE_MATERIAL_SAMPLER_MIP_MASK: u32 = ${S.MipMask}u;
const OENGINE_MATERIAL_SAMPLER_MIP_SHIFT: u32 = ${S.MipShift}u;
const OENGINE_MATERIAL_SAMPLER_FULL_MIP_CODE: u32 = ${S.FullMipCode}u;
${GPU_TEXTURE_CLAMPED_SAMPLE_WGSL}
`;
  const shader = `${declarations.join("\n")}\n${sampling}\n${packedProductHelpers}\n${callbacks.join("\n")}\n${program.source}`;
  const boundProgram: NativeMaterialProgram = Object.freeze({
    ...program,
    source: shader,
    key: JSON.stringify([program.key, shader, layoutEntries]),
    constants: Object.freeze(constants),
    resourceRevision: nativeMaterialRevision(revisions),
  });
  return Object.freeze({
    program: boundProgram,
    group,
    layoutEntries: Object.freeze(layoutEntries),
    entries: Object.freeze(entries),
    bankMask,
    productTextureCount,
    routeConstantBytes: (constants.length - program.constants.length) * 4,
  });
}

/** Main visibility and VSM raster can both use the same scalar native alpha product.
 * Their own geometry producer supplies NativeMaterialInputs with C/X/Y before discard. */
export function nativeMaterialCoverageProgram(graph: CompiledAppearanceGraph): CompiledAppearanceGraph {
  const alpha = graph.outputs.alpha;
  if (alpha === undefined || alpha.length !== 1) {
    throw new RangeError("Native coverage requires one scalar alpha output");
  }
  return selectAppearanceProductProgram(graph, { alpha });
}
