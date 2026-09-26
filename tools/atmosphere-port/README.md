# Non-Geospatial atmosphere source port

Target: Takram's `atmosphere-non-geospatial--non-geospatial` story, pinned at
`b012ad06d858fc035d88aacfd73f092f93c994e4`. The exact story is copied under
`upstream/storybook-webgpu/src/atmosphere/` for review.

This is a source migration, not a package integration. No `@takram/*` package
is a dependency of either this tool or EEngine. The unmodified upstream files
retain their original import strings. The offline compiler resolves the small
helper dependency surface to `compiler-support.ts` and copied source helpers;
unmapped exports fail the build. Three is only the pinned offline TSL compiler.

```powershell
npm ci --prefix tools/atmosphere-port --ignore-scripts
node tools/atmosphere-port/generate.mjs
node tools/atmosphere-port/generate.mjs --check
```

`sources.json` records the digest of every unmodified upstream file. Generation
checks these digests, compiles the original four compute entry points, validates
each WGSL module with pinned Naga, and writes the native shader module. `--check`
compares a fresh compilation byte-for-byte with the checked-in shader source.
Never hand-edit that output.

## Source mapping and scope

| Source entry | EEngine mapping / state |
| --- | --- |
| `NonGeospatial-Story.tsx` → `AtmosphereContext` | Reference for ordinary local scene lighting. Local-world-to-planet transform and environment authority still require production integration. |
| `AtmosphereLUTTexturesWebGPU.computeTransmittance` | Generated unchanged quadrature and LUT parameterization; native rgba16float 256×64. |
| `computeMultipleScattering` | All 64 directions, transfer-factor evaluation and workgroup reduction retained; 64×64. |
| `computeScattering` | Original 4D parameterization, combined single-Mie channel and separate higher-order output; 256×128×32 each. |
| `computeIrradiance` | Original scattering integration and LUT coordinates; 64×16. |
| `AtmosphereLightNode.setupDirect` | Required next consumer: solar transmittance/direct color plus normal-dependent sky irradiance; no white directional-light substitute. |
| `runtime.getIndirectIrradiance` | Preserve the upstream non-horizontal-surface approximation and luminance conversion; do not replace it with a constant ambient term. |
| `STBNTextureNode` | Copied 128×128×64 R8 data. Offline support preserves nearest/repeat and frame modulo 64; compute pixel centres replace fragment centres. No network loader in generated shaders. |
| Story's `temporalAntialias`, tone mapping, shadows | Host demonstrations, not Phase 3 reconstruction/shadow algorithm donors. Follow ADR-0020's FSR3 and later VSM instead. |
| Sky / aerial | Not connected by this particular story. Still required by Phase 3, using the pinned atmosphere runtime as separate mapped consumers. |

The selected LUT profile uses upstream default Earth parameters, kilometres in
the equations, combined scattering textures, higher-order scattering enabled,
and rgba16float. `AtmosphereLutResources` validates required device limits,
encodes all stages in dependency order, and publishes a generation only after
submission through record/commit/abort. It never submits independently.

Compiler adaptation is limited to explicit floating-point zero LOD literals.
The two generated mat3 texture transforms are checked as identity at generation
time and uploaded in WGSL column-padded layout. Sample counts, branch conditions,
integration intervals and reductions are not reduced.

## Copied assets

`OEngine/src/render/assets/takram/provenance.json` pins actual Git LFS payloads,
not pointer text: transmittance, irradiance, combined scattering, higher-order
scattering and scalar STBN. Their size and SHA-256 are checked in contract tests.
The bundled precomputed LUTs are reference assets until their precompute profile
is proven equivalent to the selected WebGPU profile. There is no bundled Hillaire
multiple-scattering LUT in this set. Do not silently mix these with a newly
computed generation. Package licenses are retained alongside the assets.

Current validation proves source integrity, reproducibility, WGSL validation and
resource lifecycle contracts. It does not prove rendered equivalence, Sun/Sky
production closure, performance, or Phase 3 completion.
