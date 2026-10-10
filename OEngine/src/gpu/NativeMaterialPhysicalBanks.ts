import type { TextureBindingSet } from "./TextureResidency.js";
import { decodeGpuTextureRef, GPU_TEXTURE_REF_INVALID, GPU_TEXTURE_BANK_COUNT } from "./GpuTextureRefAbi.js";
import type { CompiledAppearanceGraph } from "../material/AppearanceGraphCompiler.js";
import type { ShadeTexture } from "../texture/ShadeTexture.js";
import type { TextureSurfacePublication } from "./TextureSurfacePublication.js";

export interface NativePhysicalTextureBank {
  readonly segment: number;
  readonly view: GPUTextureView;
}

/** Borrowed whole-texture physical profile. No allocation, page table, feedback
 * or lifetime owner. The publication retains its existing Residency leases. */
export interface NativeMaterialPhysicalBankProfile {
  readonly banks: readonly NativePhysicalTextureBank[];
  readonly slots: ReadonlyMap<number, number>;
}

export interface NativeMaterialBankRequirement {
  readonly banks: readonly NativePhysicalTextureBank[];
  readonly limit: number;
}

/** Resolve only resources with an actual graph consumer. Exact coverage remains
 * a distinct R8 bank; absent logical routes execute their authored fallback. */
export function nativeMaterialRequiredBanks(
  graph: CompiledAppearanceGraph,
  set: TextureBindingSet,
  refs: ReadonlyMap<ShadeTexture, number>,
  publications: ReadonlyMap<ShadeTexture, TextureSurfacePublication>,
): readonly NativePhysicalTextureBank[] {
  const banks = new Map<number, NativePhysicalTextureBank>();
  const add = (slot: number): void => {
    const descriptor = set.bankDescriptors[slot];
    const view = set.textureBanks[slot];
    if (!descriptor || !view) throw new RangeError("Native physical texture source bank is absent");
    const prior = banks.get(descriptor.segment);
    if (prior && prior.view !== view) throw new Error("One resident segment has conflicting physical views");
    banks.set(descriptor.segment, { segment: descriptor.segment, view });
  };
  for (const sample of graph.samples) {
    const ref = refs.get(sample.binding.texture) ?? GPU_TEXTURE_REF_INVALID;
    if (ref === GPU_TEXTURE_REF_INVALID) continue;
    const decoded = decodeGpuTextureRef(ref);
    if (!decoded) throw new RangeError("Native physical bank planning requires a valid source route");
    const coverage = publications.get(sample.binding.texture)?.coverage;
    const alpha = (sample.readMask & 8) !== 0;
    if ((sample.readMask & 7) !== 0 || (alpha && !coverage)) add(decoded.bankClass);
    if (alpha && coverage) {
      const slot = set.bankDescriptors.findIndex((bank) => bank.segment === coverage.segment);
      if (slot < 0) throw new RangeError("Native exact coverage bank is absent");
      add(slot);
    }
  }
  return Object.freeze([...banks.values()].sort((a, b) => a.segment - b.segment));
}

/** Cold publication grouping, independent of material instance identities. A
 * shared scene profile is preferred; finite limits split complete bank unions,
 * never truncate resources or generate CPU draws. Each individual requirement
 * must itself fit. All consumers still use the same native bank selector. */
export function planNativeMaterialPhysicalBanks(
  requirements: readonly NativeMaterialBankRequirement[],
): readonly NativeMaterialPhysicalBankProfile[] {
  const groups: { banks: Map<number, NativePhysicalTextureBank>; limit: number }[] = [];
  const assignments: number[] = [];
  for (const requirement of requirements) {
    if (
      !Number.isInteger(requirement.limit) ||
      requirement.limit < 0 ||
      requirement.limit > GPU_TEXTURE_BANK_COUNT ||
      requirement.banks.length > requirement.limit
    ) {
      throw new RangeError("Complete native physical texture profile exceeds negotiated limits");
    }
    let selected = -1;
    for (let index = 0; index < groups.length; index++) {
      const group = groups[index]!;
      const size =
        group.banks.size + requirement.banks.filter((bank) => !group.banks.has(bank.segment)).length;
      if (size <= Math.min(group.limit, requirement.limit)) {
        selected = index;
        break;
      }
    }
    if (selected < 0) {
      selected = groups.length;
      groups.push({ banks: new Map(), limit: requirement.limit });
    }
    const group = groups[selected]!;
    group.limit = Math.min(group.limit, requirement.limit);
    for (const bank of requirement.banks) {
      const prior = group.banks.get(bank.segment);
      if (prior && prior.view !== bank.view)
        throw new Error("One resident segment has conflicting profile views");
      group.banks.set(bank.segment, bank);
    }
    assignments.push(selected);
  }
  const profiles = groups.map((group) => {
    const banks = Object.freeze(
      [...group.banks.values()]
        .sort((a, b) => a.segment - b.segment)
        .map((bank) => Object.freeze({ ...bank })),
    );
    return Object.freeze({ banks, slots: new Map(banks.map((bank, slot) => [bank.segment, slot])) });
  });
  return Object.freeze(assignments.map((index) => profiles[index]!));
}
