# FSR3 source port

This directory fixes the complete FSR3 Upscaler source profile before any WGSL
translation. The source is the AMD FidelityFX SDK 1.1.4 repository at commit
`c6efa6bf7f2027b3ec94f28578bb5965eabb9e55`.

The vendor subset contains the host dispatch implementation, public/private
contracts, the FSR3 common/callback/resource headers, the SDK shader compile
recipe, and both upstream HLSL and GLSL entry sources for every selected
upscaler stage. Files under `upstream/` are copied byte-for-byte. `sources.json`
records the immutable SHA-256 digest of every file.

The selected profile is the FSR3 Upscaler only. FSR2, FSR3 Frame Generation,
and generated binary permutation blobs are outside this source set. The binary
blobs are build products; the source mapping preserves their host permutation
selection and the original compile recipe for the future WebGPU backend.
The small generic SDK host ABI headers are retained because the pinned host
implementation includes them; their unrelated effect enum and callback
declarations are dependency context, not selected FSR2 or Frame Generation
algorithm stages.

Run the focused check with:

```powershell
node tools/fsr3-port/generate-manifest.mjs
node tools/fsr3-port/validate.mjs
```

`generate-manifest.mjs` must be rerun only after an intentional source change;
`validate.mjs` fails on missing files, digest drift, missing stages, prohibited
FSR2/frame-generation files, an altered commit, or a premature port status.

This is source acquisition and mapping evidence. It does not claim that the
WGSL stage port or production FSR3 execution is complete.
