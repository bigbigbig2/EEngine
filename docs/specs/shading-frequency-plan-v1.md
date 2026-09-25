---
id: shading-frequency-plan-v1
kind: spec
owner: shading
---
# Shading Frequency Plan V1

Status: draft

Owners: Visibility & Surface / shading

## Version/Compatibility

Phase 2 conservative profile; formal performance and quality evidence open.

## Contract

One `u32` per 4×4 tile of internal resolution, row major, with `tilesX = ceil(width / 4)` and `tilesY = ceil(height / 4)`. Bit 4 means one representative for the whole 4×4 tile. Otherwise bits 0–3 mean one representative for each selected 2×2 cell, indexed `((localY >> 1) << 1) | (localX >> 1)`. A clear bit means full rate. Upper bits are reserved and zero. The GPU producer writes every tile word once, including edge tiles. The CPU checks `tilesX * tilesY * 4` against the negotiated buffer and dispatch limits before allocation. There is no plan overflow: unsupported capacity rejects this representation instead of truncating.

The plan is generated after VisibilityKey and depth, before Surface reconstruction, texture sampling or BRDF evaluation. The current **Coverage/Identity** band requires every pixel in a candidate block to have the same valid VisibilityKey, a bounded depth difference based on the anchor's x/y depth slopes, and a static instance with valid motion identity. A partial screen-edge block or invalid work/material/instance identity remains full. The **Material Appearance** band permits only opaque unlit factor program 0, binding set 0, with exactly the valid/unlit payload flags: no texture, vertex color, alpha mask, normal map, emissive or other special material dependence. The **Lighting** band accepts that program because it evaluates no direct, indirect, shadow, reflection or specular signal. Every lit class and all other unlit programs currently remain full. This is a deliberately narrow legal band, not a claim that the complete adaptive policy or Intel's classifier has been ported.

The plan producer uses one compute invocation per 4×4 tile. It first tests the complete tile; if ineligible, it tests the four 2×2 cells independently. The two ShadingWork scans use the same plan word to count and scatter **only representative pixels**. `ShadingWorkRecord` remains the 8-byte `(pixel, VisibilityKey)` record; `attempted` and `written` now count material evaluations, not all covered visibility samples. The queue retains `width * height` capacity, so even all-full fallback fits. The material-class indirect consumer shades those representatives. Present samples the shaded anchor for each coarse member, or its own pixel for full rate; this current-frame spatial reconstruction writes every covered sample and never reads history. Exact-key and material conditions mean the accepted unlit value is constant within each selected block. Queue overflow still makes the whole presented frame visibly erroneous.

If no class-0 material is active, Renderer omits the plan pass, plan buffer, extra bindings and reconstruction specialization. `spatial_shading_frequency_enabled = false` selects the full-rate specialization on the same Renderer path, with a distinct graph key and no frequency-plan resource or pass; the setting survives device recovery. CPU never reads the plan or counters to decide current-frame work. `diagnosticShadingFrequency()` is an explicit, asynchronous GPU copy used only by the independent validation host. Phase 2 browser diagnostics show 2×2 and 4×4 blocks, reduced material evaluation count, interior coverage, fail-visible generation corruption, odd internal dimensions, and dynamic instance identity falling back to full rate. The full/spatial comparison checks matching presented pixels and records GPU timestamp durations for plan, queue scans, material classes and Present when the adapter exposes `timestamp-query`. A single diagnostic workload does **not** establish net GPU time benefit; fixed-condition comparisons across representative scene mixes and target adapters remain required before a performance claim or broader material bands.

The upstream [Intel DeferredCoarsePixelShading R20](../porting/next-renderer.md) supplies the coarse/full/fallback/all-samples-consumed closure. Its four prebuilt GBuffer surfaces, view-space normal threshold, tile-local light list and flat-MSAA output are not this algorithm. EEngine's pre-material eligibility, exact VisibilityKey boundary, 4×4 extension and WebGPU queue/Present lowering are named local design differences, not an upstream port. No temporal reuse is legal before Phase 3 history contracts.

## Validation

`shading-frequency-plan.test.mjs` checks capacity and odd-edge tile counts. The independent `phase1-visibility` browser case checks actual GPU 2×2/4×4 work counts, spatial coverage, full-rate feature-off, dynamic-identity rejection, odd extent and error paths as diagnostic evidence. Its GPU timestamp A/B is an exploratory Surface-pass sum, not a complete frame or formal PERF result. Whole-frame performance and formal quality gates remain open.
