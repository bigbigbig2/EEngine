# R5-06 Screen-Space Reflections revalidation record

## Status

- Decision: `retained-current-authored`
- External implementation: `not adopted`
- Gate: FX-08 must revalidate the current OEngine SSR before any replacement is considered.

## Current implementation ownership

The live `ssr_trace`, `ssr_prefilter`, `ssr_resolve`, `ssr_denoise`, and shared
indirect-composite path are OEngine-authored sources. The shader source audit
classifies them as `authored-live`; this record does not claim that they were
ported from FidelityFX or another upstream implementation.

The retained invariants for FX-08 are:

- consume the main-frame HZB, Surface ABI roughness/normal, Velocity, and the
  FX-06A submission-aware temporal history registry;
- keep miss fallback on the declared environment/IBL path;
- keep the shared indirect composite as the only final composition owner;
- prune SSR passes, histories, and debug resources when the feature is off.

## Candidate checked, not adopted

AMD FidelityFX SSSR remains the named replacement candidate from the R5
execution documents. Its upstream license is MIT. It is **not adopted** for
this change because the repository requires the existing authored SSR to be
revalidated first. No FidelityFX source, translated source, or expression-level
implementation is copied by this record.

Replacement may be reconsidered only if the production FX-08 correctness,
quality, or performance Gate fails. At that point this record must be expanded
with the exact upstream repository, commit/tag, source paths, preserved
invariants, WebGPU differences, and paired old/new artifacts before code is
ported.

## Revalidation result

The retained authored implementation passed the clean production Gate on commit
`62158e9f20c081d12a832f01ae057678346e3796`; FidelityFX SSSR remains not adopted.
The artifact is `temp/r5/fx-08/62158e9f20c081d12a832f01ae057678346e3796/`.
The result covers hit/miss, roughness `0 / 0.5 / 1`, environment fallback,
offscreen target, pan/disocclusion response and settling, shared temporal history,
feature-off exact-zero SSR ownership, and phase timestamps. FX-06B and G5-T remain
open.

## Q04 deterministic reconstruction update

2026-09-02 Q04 retains the same OEngine-authored implementation and does not
adopt or copy FidelityFX SSSR. The production chain is now half-resolution by
default: trace, resolve, one spatial filter, optional temporal accumulation,
then full-resolution joint bilateral upscale. Full-resolution remains an
explicit quality topology, not a second pipeline.

The trace now terminates on physical max distance during marching, applies edge
confidence at the hit coordinate, derives thickness from a meter-based base plus
traveled-distance expansion, and rejects above the configured roughness cutoff.
AO/SSR share the opaque temporal validity layer; final transparency validity is
owned only by final TAA. The update reduces trace pixels and removes two spatial
passes at the cost of one edge-aware upscale pass and half-resolution history.
The focused RTX 2060 SUPER dirty/full result is recorded in
`docs/PERFORMANCE.md`; clean/full provenance and G5-P remain open.

## FX-08 revalidation contract

The production fixture and Gate must cover a mirror plane with a visible
reflected object, screen miss, roughness `0 / 0.5 / 1`, an offscreen target,
camera pan/disocclusion, feature-off exact-zero ownership, SSR hit/miss and
history-confidence debug outputs, and trace/denoise/composite GPU timing.
