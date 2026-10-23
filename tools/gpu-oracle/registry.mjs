// Registry of real-GPU oracles.
//
// Adding oracle #4 is one entry here plus its module; the CLI, the host page and
// the static server need no new code. Fields:
//   name         CLI selector
//   file         repository-relative path on disk (existence preflight + reports)
//   url          origin-relative URL the browser imports
//   entry        exported function called as entry(device)
//   allowPrefixes extra static-server prefixes this oracle additionally needs
//   note         provenance, or the exact observed blocker, shown in reports

export const oracles = Object.freeze([
  Object.freeze({
    name: "image-texture-residency",
    file: "OEngine/tests/oracle/image-texture-residency-gpu.mjs",
    url: "/OEngine/tests/oracle/image-texture-residency-gpu.mjs",
    entry: "runImageTextureResidencyGpu",
    requiredFeatures: ["texture-compression-bc"],
    requiredLimits: { maxStorageBuffersPerShaderStage: 16 },
    allowPrefixes: [".local/extreme-web-asset/"],
    timeoutMs: 180000,
    description: "Schema4 actual resident/VT owners, native BC5 consumption and protected-tail publication.",
    note: "Local evaluation kernels only; GPU jobs run serially."
  }),
  Object.freeze({
    name: "image-texture-page-f16",
    file: "OEngine/tests/oracle/image-texture-page-gpu.mjs",
    url: "/OEngine/tests/oracle/image-texture-page-gpu.mjs",
    entry: "runImageTexturePageGpuF16",
    requiredFeatures: ["texture-compression-bc", "shader-f16"],
    allowPrefixes: [".local/extreme-web-asset/"],
    timeoutMs: 180000,
    description: "E2 same complete unique-owner assembly and stock donor BC with original f16 kernels.",
    note: "Local evaluation only; run serially with other GPU jobs."
  }),
  Object.freeze({
    name: "image-texture-page",
    file: "OEngine/tests/oracle/image-texture-page-gpu.mjs",
    url: "/OEngine/tests/oracle/image-texture-page-gpu.mjs",
    entry: "runImageTexturePageGpu",
    requiredFeatures: ["texture-compression-bc"],
    allowPrefixes: [".local/extreme-web-asset/"],
    timeoutMs: 180000,
    description:
      "E2 unique AVIF owners, complete reservation, NPOT/mirror/repeat GPU assembly and stock donor BC.",
    note: "Local evaluation only, no production cutover. Generate page-fixtures.mjs first."
  }),
  Object.freeze({
    name: "image-texture-transcode-f16",
    file: "OEngine/tests/oracle/image-texture-transcode-gpu.mjs",
    url: "/OEngine/tests/oracle/image-texture-transcode-gpu.mjs",
    entry: "runImageTextureTranscodeGpuF16",
    requiredFeatures: ["texture-compression-bc", "shader-f16"],
    allowPrefixes: [".local/extreme-web-asset/"],
    timeoutMs: 180000,
    description: "E1 same complete local evaluation closure with faithful f16 upstream kernels.",
    note: "No production shader redistribution/adoption. Run serially with f32."
  }),
  Object.freeze({
    name: "image-texture-transcode",
    file: "OEngine/tests/oracle/image-texture-transcode-gpu.mjs",
    url: "/OEngine/tests/oracle/image-texture-transcode-gpu.mjs",
    entry: "runImageTextureTranscodeGpu",
    requiredFeatures: ["texture-compression-bc"],
    allowPrefixes: [".local/extreme-web-asset/"],
    timeoutMs: 180000,
    description:
      "E1 schema4 native AVIF, real shared Worker leases, faithful Spark BC7/BC5/BC4 and mip/abort/fence.",
    note: "Pinned local evaluation shaders only, not production vendor/adoption. Generate E1 fixtures first."
  }),
  Object.freeze({
    name: "scgi-gather-materials",
    file: "OEngine/tests/oracle/scgi-gather-materials-gpu.mjs",
    url: "/OEngine/tests/oracle/scgi-gather-materials-gpu.mjs",
    entry: "runScgiGatherMaterialsGpuOracle",
    requiredLimits: { maxStorageBuffersPerShaderStage: 16 },
    timeoutMs: 300000,
    allowPrefixes: ["OEngine/src/render/assets/", "OEngine/src/assets/web-cook/wasm/vendor/"],
    description: "SCGI gather on existing max-binding Native/VT/MASK/VSM production matrix."
  }),
  Object.freeze({
    name: "scgi-gather",
    file: "OEngine/tests/oracle/scgi-gather-gpu.mjs",
    url: "/OEngine/tests/oracle/scgi-gather-gpu.mjs",
    entry: "runScgiGatherGpuOracle",
    requiredLimits: { maxStorageBuffersPerShaderStage: 16 },
    timeoutMs: 300000,
    allowPrefixes: ["OEngine/src/render/assets/", "OEngine/src/assets/web-cook/wasm/vendor/"],
    description: "SCGI-9 dedicated room, actual Native source, screen probes and signed residual."
  }),
  Object.freeze({
    name: "scgi-production",
    file: "OEngine/tests/oracle/scgi-production-gpu.mjs",
    url: "/OEngine/tests/oracle/scgi-production-gpu.mjs",
    entry: "runScgiProductionGpuOracle",
    requiredLimits: { maxStorageBuffersPerShaderStage: 16 },
    timeoutMs: 180000,
    allowPrefixes: [
      ".local/extreme-web-asset/",
      "OEngine/src/render/assets/",
      "OEngine/src/assets/web-cook/wasm/vendor/"
    ],
    description: "SCGI-8 public Renderer, Product, transport, field and Native consumption."
  }),
  Object.freeze({
    name: "scgi-filter",
    file: "OEngine/tests/oracle/scgi-filter-gpu.mjs",
    url: "/OEngine/tests/oracle/scgi-filter-gpu.mjs",
    entry: "runScgiFilterGpuOracle",
    requiredFeatures: ["timestamp-query"],
    requiredLimits: { maxStorageBuffersPerShaderStage: 16 },
    timeoutMs: 180000,
    description: "SCGI-7 actual A0/A1/A2 and field, independent moments, steps and quantization."
  }),
  Object.freeze({
    name: "scgi-estimator",
    file: "OEngine/tests/oracle/scgi-estimator-gpu.mjs",
    url: "/OEngine/tests/oracle/scgi-estimator-gpu.mjs",
    entry: "runScgiEstimatorGpuOracle",
    requiredFeatures: ["timestamp-query"],
    requiredLimits: { maxStorageBuffersPerShaderStage: 16 },
    timeoutMs: 180000,
    description:
      "SCGI-6 actual Product/native/query/light/cache estimator and independent transport expectations."
  }),
  Object.freeze({
    name: "scgi-query-vt",
    file: "OEngine/tests/oracle/scgi-query-vt-gpu.mjs",
    url: "/OEngine/tests/oracle/scgi-query-vt-gpu.mjs",
    entry: "runScgiQueryVtGpuOracle",
    allowPrefixes: [".local/extreme-web-asset/"],
    requiredFeatures: ["texture-compression-bc"],
    requiredLimits: { maxStorageBuffersPerShaderStage: 16 },
    timeoutMs: 120000,
    description:
      "SCGI-5 actual Native query, independent VT feedback and ordinary coarse-to-fine mapping publication."
  }),
  Object.freeze({
    name: "scgi-query",
    file: "OEngine/tests/oracle/scgi-query-gpu.mjs",
    url: "/OEngine/tests/oracle/scgi-query-gpu.mjs",
    entry: "runScgiQueryGpuOracle",
    requiredFeatures: ["timestamp-query", "subgroups"],
    requiredLimits: { maxStorageBuffersPerShaderStage: 16 },
    timeoutMs: 180000,
    description:
      "SCGI-5 build/update, shared BLAS/affines, compact TLAS, GPU ray count, complete alpha and independent brute-force."
  }),
  Object.freeze({
    name: "scgi-anchor-publication",
    file: "OEngine/tests/oracle/scgi-anchor-publication-gpu.mjs",
    url: "/OEngine/tests/oracle/scgi-anchor-publication-gpu.mjs",
    entry: "runScgiAnchorPublicationGpuOracle",
    requiredLimits: { maxStorageBuffersPerShaderStage: 16 },
    timeoutMs: 60000,
    description: "SCGI-4 real scene/frame/Product/material anchor publication and seed abort/retry."
  }),
  Object.freeze({
    name: "scgi-query-cut",
    file: "OEngine/tests/oracle/scgi-query-cut-gpu.mjs",
    url: "/OEngine/tests/oracle/scgi-query-cut-gpu.mjs",
    entry: "runScgiQueryCutGpuOracle",
    requiredLimits: { maxStorageBuffersPerShaderStage: 16 },
    timeoutMs: 60000,
    description: "SCGI-2 GPU world-domain demand, bounded page cut, delayed streaming and current coverage."
  }),
  Object.freeze({
    name: "scgi-anchor",
    file: "OEngine/tests/oracle/scgi-anchor-gpu.mjs",
    url: "/OEngine/tests/oracle/scgi-anchor-gpu.mjs",
    entry: "runScgiAnchorGpuOracle",
    requiredLimits: { maxStorageBuffersPerShaderStage: 16 },
    timeoutMs: 180000,
    description: "SCGI-4 primary anchors, complete identity and committed world-only seed."
  }),
  Object.freeze({
    name: "scgi-cache",
    file: "OEngine/tests/oracle/scgi-cache-gpu.mjs",
    url: "/OEngine/tests/oracle/scgi-cache-gpu.mjs",
    entry: "runScgiCacheGpuOracle",
    requiredFeatures: ["timestamp-query"],
    requiredLimits: { maxStorageBuffersPerShaderStage: 16 },
    timeoutMs: 180000,
    description: "SCGI-3 sparse cache allocation, R24 scroll, rank aging, capacity and transactional retry."
  }),
  Object.freeze({
    name: "scgi-transaction",
    file: "OEngine/tests/oracle/scgi-transaction-gpu.mjs",
    url: "/OEngine/tests/oracle/scgi-transaction-gpu.mjs",
    entry: "runScgiTransactionGpuOracle",
    requiredLimits: { maxStorageBuffersPerShaderStage: 16 },
    timeoutMs: 180000,
    description:
      "SCGI-1 typed ABI, actual Native descriptors and real command double-bank abort/retry/retirement."
  }),
  Object.freeze({
    name: "streaming-vt-feedback",
    file: "OEngine/tests/oracle/streaming-vt-feedback-gpu.mjs",
    url: "/OEngine/tests/oracle/streaming-vt-feedback-gpu.mjs",
    entry: "runStreamingVtFeedbackGpuOracle",
    timeoutMs: 60000,
    description:
      "Real 65537-page overflow, lossless bitset recovery, wanted/used dedup and delayed full ring."
  }),
  Object.freeze({
    name: "sssr-production",
    file: "OEngine/tests/oracle/sssr-production-gpu.mjs",
    url: "/OEngine/tests/oracle/sssr-production-gpu.mjs",
    entry: "runSssrProductionGpuOracle",
    requiredFeatures: ["texture-compression-bc", "texture-formats-tier1"],
    requiredLimits: { maxStorageBuffersPerShaderStage: 16 },
    allowPrefixes: [
      "OEngine/src/render/assets/textures/",
      "OEngine/src/render/assets/sssr/",
      "OEngine/src/assets/web-cook/wasm/vendor/"
    ],
    timeoutMs: 180000,
    description: "Native SSSR production profile, complete FrameProgram and bounded lifecycle."
  }),
  Object.freeze({
    name: "sssr-algorithm",
    file: "OEngine/tests/oracle/sssr-algorithm-gpu.mjs",
    url: "/OEngine/tests/oracle/sssr-algorithm-gpu.mjs",
    entry: "runSssrAlgorithmGpuOracle",
    allowPrefixes: ["OEngine/src/render/assets/sssr/"],
    requiredFeatures: ["texture-formats-tier1"],
    requiredLimits: { maxStorageBuffersPerShaderStage: 8 },
    description:
      "Selected full SSSR and reflection denoiser, bounded two-lobe nonproduction closure and independent small numeric fixtures.",
    timeoutMs: 180000
  }),
  Object.freeze({
    name: "ao-functionality",
    file: "OEngine/tests/oracle/ao-functionality-gpu.mjs",
    url: "/OEngine/tests/oracle/ao-functionality-gpu.mjs",
    entry: "runAoFunctionalityGpuOracle",
    requiredFeatures: ["texture-compression-bc", "texture-formats-tier1"],
    requiredLimits: { maxStorageBuffersPerShaderStage: 16 },
    allowPrefixes: ["OEngine/src/render/assets/textures/"],
    timeoutMs: 180000,
    description: "Small real Renderer AO tuning, final scalar/debug/HDR and abort/resize/recovery closure."
  }),
  Object.freeze({
    name: "product-attribute-decode",
    file: "OEngine/tests/oracle/product-attribute-decode-gpu.mjs",
    url: "/OEngine/tests/oracle/product-attribute-decode-gpu.mjs",
    entry: "runProductAttributeDecodeGpuOracle",
    requiredLimits: { maxStorageBuffersPerShaderStage: 16 },
    description:
      "Production compact Page attributes vs independent CPU scalar math, all masks, banks and cross-word reads."
  }),
  Object.freeze({
    name: "vsm-bias",
    file: "OEngine/tests/oracle/vsm-bias-gpu.mjs",
    url: "/OEngine/tests/oracle/vsm-bias-gpu.mjs",
    entry: "runVsmBiasGpuOracle",
    description:
      "Actual rasterized inclined receiver/contact caster, plane correction and independent bias sweep with negative controls.",
    timeoutMs: 180000
  }),
  Object.freeze({
    name: "final-pixel-seed-quality",
    file: "OEngine/tests/oracle/native-surface-integration-gpu.mjs",
    url: "/OEngine/tests/oracle/native-surface-integration-gpu.mjs",
    entry: "runFinalPixelSeedQualityGpuOracle",
    allowPrefixes: [".local/extreme-web-asset/"],
    requiredLimits: { maxStorageBuffersPerShaderStage: 16 },
    requiredFeatures: ["texture-compression-bc", "texture-formats-tier1"],
    description:
      "Phase3 actual Native Seed vs frozen Facts and current T3, four 1080p dynamic 256-frame sequences.",
    timeoutMs: 600000
  }),
  Object.freeze({
    name: "final-pixel-sun-response",
    file: "OEngine/tests/oracle/final-pixel-sun-response-gpu.mjs",
    url: "/OEngine/tests/oracle/final-pixel-sun-response-gpu.mjs",
    entry: "runFinalPixelSunResponseGpuOracle",
    timeoutMs: 120000,
    description:
      "Invocation-private Sun BRDF response against frozen math, exact HDR/coat/visibility and overflow finite guards."
  }),
  Object.freeze({
    name: "final-pixel-shadow-quality",
    file: "OEngine/tests/oracle/final-pixel-shadow-quality-gpu.mjs",
    url: "/OEngine/tests/oracle/final-pixel-shadow-quality-gpu.mjs",
    entry: "runFinalPixelShadowQualityGpuOracle",
    allowPrefixes: ["OEngine/src/render/assets/textures/"],
    requiredLimits: { maxStorageBuffersPerShaderStage: 16 },
    timeoutMs: 600000,
    description:
      "Full 1080p 256-frame Native receiver/Sun visibility against analytic planes, all page boundaries and frozen S3 quality envelope."
  }),
  Object.freeze({
    name: "final-pixel-seed-epoch",
    file: "OEngine/tests/oracle/final-pixel-phase1-gpu.mjs",
    url: "/OEngine/tests/oracle/final-pixel-phase1-gpu.mjs",
    entry: "runFinalPixelSeedEpochGpuOracle",
    allowPrefixes: [".local/extreme-web-asset/"],
    description:
      "Real Seed producer/consumer and pending resize released on controlled device destruction, fresh invalid histories on two epochs.",
    timeoutMs: 120000
  }),
  Object.freeze({
    name: "final-pixel-solar",
    file: "OEngine/tests/oracle/final-pixel-solar-gpu.mjs",
    url: "/OEngine/tests/oracle/final-pixel-solar-gpu.mjs",
    entry: "runFinalPixelSolarGpuOracle",
    description:
      "Unchanged half LUT publication and linear clamp samples against independent numeric and filtered provider references.",
    timeoutMs: 120000
  }),
  Object.freeze({
    name: "final-pixel-phase1-minimum",
    file: "OEngine/tests/oracle/final-pixel-phase1-gpu.mjs",
    url: "/OEngine/tests/oracle/final-pixel-phase1-gpu.mjs",
    entry: "runFinalPixelPhase1GpuOracle",
    allowPrefixes: [".local/extreme-web-asset/"],
    requiredLimits: { maxStorageBuffersPerShaderStage: 16 },
    requiredFeatures: ["texture-formats-tier1", "texture-compression-bc"],
    timeoutMs: 300000,
    description:
      "Complete nonproduction V5 closure on 16 sampled / 16 storage binding limits, including real maximum material consumers."
  }),
  Object.freeze({
    name: "final-pixel-phase1",
    file: "OEngine/tests/oracle/final-pixel-phase1-gpu.mjs",
    url: "/OEngine/tests/oracle/final-pixel-phase1-gpu.mjs",
    entry: "runFinalPixelPhase1GpuOracle",
    allowPrefixes: [".local/extreme-web-asset/"],
    requiredLimits: { maxStorageBuffersPerShaderStage: 16, maxSampledTexturesPerShaderStage: 19 },
    requiredFeatures: ["texture-formats-tier1", "texture-compression-bc"],
    timeoutMs: 300000,
    description:
      "Nonproduction V5 single reconstruction/Sun/Seed to real Temporal consumer; full writer domains, direct directory producers and submit lifecycle."
  }),
  Object.freeze({
    name: "final-pixel-binding-boundary",
    file: "OEngine/tests/oracle/final-pixel-phase1-gpu.mjs",
    url: "/OEngine/tests/oracle/final-pixel-phase1-gpu.mjs",
    entry: "runFinalPixelBindingBoundaryGpuOracle",
    allowPrefixes: [".local/extreme-web-asset/"],
    requiredLimits: { maxStorageBuffersPerShaderStage: 16 },
    description:
      "The old sampled-limit counterexample compiles with fused Sun at the negotiated minimum limit, without continuation.",
    timeoutMs: 120000
  }),
  Object.freeze({
    name: "final-pixel-temporal-probe",
    file: "OEngine/tests/oracle/final-pixel-temporal-matrix-gpu.mjs",
    url: "/OEngine/tests/oracle/final-pixel-temporal-matrix-gpu.mjs",
    entry: "runFinalPixelTemporalProbeGpuOracle",
    requiredFeatures: ["texture-formats-tier1"],
    timeoutMs: 300000,
    description: "Diagnostic 80-frame thin-feature intermediate probes; no quality qualification."
  }),
  Object.freeze({
    name: "final-pixel-temporal-matrix",
    file: "OEngine/tests/oracle/final-pixel-temporal-matrix-gpu.mjs",
    url: "/OEngine/tests/oracle/final-pixel-temporal-matrix-gpu.mjs",
    entry: "runFinalPixelTemporalMatrixGpuOracle",
    requiredFeatures: ["texture-formats-tier1"],
    timeoutMs: 1800000,
    description:
      "Six frozen 1080p 256-frame dynamic families, bounded GPU metrics and 8phase history, HDR/display/peak/energy/trail/settling."
  }),
  Object.freeze({
    name: "final-pixel-temporal-pull",
    file: "OEngine/tests/oracle/final-pixel-temporal-pull-gpu.mjs",
    url: "/OEngine/tests/oracle/final-pixel-temporal-pull-gpu.mjs",
    entry: "runFinalPixelTemporalPullGpuOracle",
    requiredFeatures: ["texture-formats-tier1"],
    timeoutMs: 300000,
    description:
      "Isolated complete V5 pull candidate versus production 015548 and independent 8x8 goldens; no production selector."
  }),
  Object.freeze({
    name: "final-pixel-temporal-pull-semantics",
    file: "OEngine/tests/oracle/final-pixel-temporal-pull-semantics-gpu.mjs",
    url: "/OEngine/tests/oracle/final-pixel-temporal-pull-semantics-gpu.mjs",
    entry: "runFinalPixelTemporalPullSemanticsGpuOracle",
    requiredFeatures: ["texture-formats-tier1"],
    timeoutMs: 120000,
    description:
      "Complete AMD Resolve profile differential, own Seed reprojection, previous-depth pull and cached submission lifecycle."
  }),
  Object.freeze({
    name: "final-pixel-temporal-writer",
    file: "OEngine/tests/oracle/final-pixel-phase1-gpu.mjs",
    url: "/OEngine/tests/oracle/final-pixel-phase1-gpu.mjs",
    entry: "runFinalPixelTemporalWriterGpuOracle",
    allowPrefixes: [".local/extreme-web-asset/"],
    requiredLimits: { maxStorageBuffersPerShaderStage: 16 },
    requiredFeatures: ["texture-compression-bc", "texture-formats-tier1"],
    timeoutMs: 180000,
    description:
      "Actual Native Surface Seed -> V2 graph with joint ShadeGPUCommandContext submission, abort and fence retirement.",
    note: "Nonproduction component closure; existing upscale classification fixtures remain, not a Renderer policy/quality acceptance."
  }),
  Object.freeze({
    name: "native-temporal-identity",
    file: "OEngine/tests/oracle/native-temporal-identity-gpu.mjs",
    url: "/OEngine/tests/oracle/native-temporal-identity-gpu.mjs",
    entry: "runNativeTemporalIdentityGpuOracle",
    description:
      "Full four-word production Seed identity and classifier, large instances/material slots and changed signatures.",
    timeoutMs: 60000
  }),
  Object.freeze({
    name: "native-temporal-v2",
    file: "OEngine/tests/oracle/native-temporal-v2-gpu.mjs",
    url: "/OEngine/tests/oracle/native-temporal-v2-gpu.mjs",
    entry: "runNativeTemporalV2GpuOracle",
    requiredFeatures: ["texture-formats-tier1"],
    timeoutMs: 300000,
    description:
      "Native-resolution chain versus frozen FSR and analytic HDR/motion sequences, per-frame ROI response and partial domains."
  }),
  Object.freeze({
    name: "native-temporal-observation-quality",
    file: "OEngine/tests/oracle/native-temporal-observation-gpu.mjs",
    url: "/OEngine/tests/oracle/native-temporal-observation-gpu.mjs",
    entry: "runNativeTemporalObservationQualityGpuOracle",
    requiredFeatures: ["texture-formats-tier1"],
    timeoutMs: 300000,
    description:
      "Production Native observation owner against unchanged independent analytic quality contracts."
  }),
  Object.freeze({
    name: "native-temporal-observation-matrix",
    file: "OEngine/tests/oracle/native-temporal-observation-gpu.mjs",
    url: "/OEngine/tests/oracle/native-temporal-observation-gpu.mjs",
    entry: "runNativeTemporalObservationMatrixGpuOracle",
    requiredFeatures: ["texture-formats-tier1"],
    timeoutMs: 1800000,
    description: "Production observation graph with unchanged six-family 1080p dynamic quality matrix."
  }),
  Object.freeze({
    name: "native-temporal-observation-cost",
    file: "OEngine/tests/oracle/native-temporal-observation-cost-gpu.mjs",
    url: "/OEngine/tests/oracle/native-temporal-observation-cost-gpu.mjs",
    entry: "runNativeTemporalObservationCostGpuOracle",
    requiredFeatures: ["texture-formats-tier1", "timestamp-query"],
    timeoutMs: 300000,
    description:
      "Frozen pre-rework Native chain versus production observation graph, all eight jitter phases; synthetic cost only."
  }),
  Object.freeze({
    name: "native-temporal-observation-replay",
    file: "OEngine/tests/oracle/native-temporal-observation-replay-gpu.mjs",
    url: "/OEngine/tests/oracle/native-temporal-observation-replay-gpu.mjs",
    entry: "runNativeTemporalObservationReplayGpuOracle",
    requiredFeatures: ["texture-formats-tier1", "timestamp-query"],
    allowPrefixes: [".local/native-temporal-observation-20261012/A1-v2/temporal-inputs/"],
    timeoutMs: 300000,
    description:
      "Same captured actual Dungeon color/Seed/identity/previous histories, complete Native chain ABBA with pass timestamps."
  }),
  Object.freeze({
    name: "native-temporal-observation-boundary",
    file: "OEngine/tests/oracle/native-temporal-observation-boundary-gpu.mjs",
    url: "/OEngine/tests/oracle/native-temporal-observation-boundary-gpu.mjs",
    entry: "runNativeTemporalObservationBoundaryGpuOracle",
    requiredFeatures: ["texture-formats-tier1"],
    timeoutMs: 120000,
    description:
      "Actual R8 stores and filtered RG16 producer versus pinned SDK, all eight phases, odd/tiny/full domains."
  }),
  Object.freeze({
    name: "native-temporal-observation-measure",
    file: "OEngine/tests/oracle/native-temporal-observation-measure-gpu.mjs",
    url: "/OEngine/tests/oracle/native-temporal-observation-measure-gpu.mjs",
    entry: "runNativeTemporalObservationMeasureGpuOracle",
    requiredFeatures: ["texture-formats-tier1"],
    timeoutMs: 300000,
    description:
      "Exact Measure/Exposure products against frozen original, tiny/odd/tile seams/1080p/full 4096 limit."
  }),
  Object.freeze({
    name: "native-temporal-v2-cost",
    file: "OEngine/tests/oracle/native-temporal-v2-cost-gpu.mjs",
    url: "/OEngine/tests/oracle/native-temporal-v2-cost-gpu.mjs",
    entry: "runNativeTemporalV2CostGpuOracle",
    requiredFeatures: ["texture-formats-tier1", "timestamp-query"],
    timeoutMs: 300000,
    description:
      "ABBA complete native-resolution temporal chains at 1080p against frozen before; raw timestamps, not a gain assertion."
  }),
  Object.freeze({
    name: "vsm-shadow-receiver",
    file: "OEngine/tests/oracle/vsm-shadow-receiver-gpu.mjs",
    url: "/OEngine/tests/oracle/vsm-shadow-receiver-gpu.mjs",
    entry: "runVsmShadowReceiverGpuOracle",
    requiredLimits: { maxStorageBuffersPerShaderStage: 16 },
    description:
      "Production depth/geometry receiver against analytic flat/sloped/perspective/mirrored planes and isolated winners."
  }),
  Object.freeze({
    name: "vsm-shadow-resolve",
    file: "OEngine/tests/oracle/vsm-shadow-resolve-gpu.mjs",
    url: "/OEngine/tests/oracle/vsm-shadow-resolve-gpu.mjs",
    entry: "runVsmShadowResolveGpuOracle",
    requiredLimits: { maxStorageBuffersPerShaderStage: 16 },
    description:
      "Production packed Shadow Resolve/decoder against analytic receiver and per-pixel PCF; partial/neutral/stale/abort/resize."
  }),
  Object.freeze({
    name: "vsm-v4-r1",
    file: "OEngine/tests/oracle/vsm-v4-r1-gpu.mjs",
    url: "/OEngine/tests/oracle/vsm-v4-r1-gpu.mjs",
    entry: "runVsmR1GpuOracle",
    description:
      "Complete affine caster depth against eight corners, invalid/empty domain, signed world-window retention."
  }),
  Object.freeze({
    name: "vsm-local-invalidation",
    file: "OEngine/tests/oracle/vsm-local-invalidation-gpu.mjs",
    url: "/OEngine/tests/oracle/vsm-local-invalidation-gpu.mjs",
    entry: "runVsmLocalInvalidationGpuOracle",
    description:
      "Production complete caster old/new damage, stable/expanded depth, full identities, all clips/mips/gutters, MASK and abort/growth retry."
  }),
  Object.freeze({
    name: "native-authored-ibl-production",
    file: "OEngine/tests/oracle/native-surface-production-gpu.mjs",
    url: "/OEngine/tests/oracle/native-surface-production-gpu.mjs",
    entry: "runNativeSurfaceAuthoredIblProductionGpuOracle",
    allowPrefixes: [
      ".local/extreme-web-asset/",
      "OEngine/src/render/assets/",
      "validation/tools/dungeon-gpu-audit.mjs"
    ],
    requiredLimits: { maxStorageBuffersPerShaderStage: 16 },
    requiredFeatures: ["texture-formats-tier1"],
    description:
      "Real Renderer NPOT authored environment to lit Native winner, resize/abort/scene switch and controlled device recovery."
  }),
  Object.freeze({
    name: "ibl-publication",
    file: "OEngine/tests/oracle/ibl-publication-gpu.mjs",
    url: "/OEngine/tests/oracle/ibl-publication-gpu.mjs",
    entry: "runIblPublicationGpuOracle",
    description:
      "Actual physical/authored IBL publication to Native sampling: NPOT/four formats, abort retry, scratch fence, probe/Sun updates and destroy."
  }),
  Object.freeze({
    name: "ibl-filtering",
    file: "OEngine/tests/oracle/ibl-filtering-gpu.mjs",
    url: "/OEngine/tests/oracle/ibl-filtering-gpu.mjs",
    entry: "runIblFilteringGpuOracle",
    description:
      "Native oct filtering vs frozen manual math: seams, NPOT, integer mips, HDR and DFG; unchanged tolerance."
  }),
  Object.freeze({
    name: "fsr3-accumulate-cost",
    file: "OEngine/tests/oracle/fsr3-accumulate-cost-gpu.mjs",
    url: "/OEngine/tests/oracle/fsr3-accumulate-cost-gpu.mjs",
    entry: "runFsr3AccumulateCostGpuOracle",
    requiredFeatures: ["timestamp-query"],
    description:
      "ABBA same-input 1080p current tile versus general Accumulate execution; raw timestamps, no quality claim."
  }),
  Object.freeze({
    name: "fsr3-accumulate-products",
    file: "OEngine/tests/oracle/fsr3-accumulate-products-gpu.mjs",
    url: "/OEngine/tests/oracle/fsr3-accumulate-products-gpu.mjs",
    entry: "runFsr3AccumulateProductsGpuOracle",
    description:
      "Production history-write to RCAS against frozen duplicate-output math: full RGB, lock alpha, HDR, jitter, motion, partial extents and upscale ratios."
  }),
  Object.freeze({
    name: "vsm-quality-contract",
    requiredFeatures: ["clip-distances"],
    requiredLimits: { maxStorageBuffersPerShaderStage: 16 },
    file: "OEngine/tests/oracle/vsm-quality-contract-gpu.mjs",
    url: "/OEngine/tests/oracle/vsm-quality-contract-gpu.mjs",
    entry: "runVsmQualityContractGpuOracle",
    timeoutMs: 120000,
    description:
      "Production page/selection contract plus shared ordinary/Product geometry, lossless CSR, both clipping profiles, MASK gradients and abort/reset/retry."
  }),
  Object.freeze({
    name: "vsm-receiver-aggregation",
    file: "OEngine/tests/oracle/vsm-receiver-aggregation-gpu.mjs",
    url: "/OEngine/tests/oracle/vsm-receiver-aggregation-gpu.mjs",
    entry: "runVsmReceiverAggregationGpuOracle",
    description:
      "Exact production paired-page aggregation and weighted scores, 128-key collisions, partial/empty groups, bounded fallback and reset."
  }),
  Object.freeze({
    name: "performance-diagnostics",
    file: "OEngine/tests/oracle/performance-diagnostic-gpu.mjs",
    url: "/OEngine/tests/oracle/performance-diagnostic-gpu.mjs",
    entry: "runPerformanceDiagnosticGpuOracle",
    description:
      "VSM diagnostic reduction against independent CPU sets, partial/empty groups and dispatch reset."
  }),
  Object.freeze({
    name: "sky-radiometry",
    file: "OEngine/tests/oracle/sky-radiometry-gpu.mjs",
    url: "/OEngine/tests/oracle/sky-radiometry-gpu.mjs",
    entry: "runSkyRadiometryGpuOracle",
    description:
      "Production pre-exposure, HDR percentile/highlight metering, elapsed-time EV adaptation and exposure-owned abort/retry."
  }),
  Object.freeze({
    name: "physical-sky-motion",
    file: "OEngine/tests/oracle/physical-sky-motion-gpu.mjs",
    url: "/OEngine/tests/oracle/physical-sky-motion-gpu.mjs",
    entry: "runPhysicalSkyMotionGpuOracle",
    requiredFeatures: ["timestamp-query"],
    timeoutMs: 120000,
    description: "Actual moving sky probes: complete mip/diffuse revisit equality and producer GPU cost."
  }),
  Object.freeze({
    name: "sky-ibl-dfg",
    file: "OEngine/tests/oracle/sky-ibl-dfg-gpu.mjs",
    url: "/OEngine/tests/oracle/sky-ibl-dfg-gpu.mjs",
    entry: "runSkyIblDfgGpuOracle",
    description:
      "Production Fc/Total LUT and environment consumer against independent Schlick/Smith BRDF integration."
  }),
  Object.freeze({
    name: "fsr3-shading-pyramid",
    file: "OEngine/tests/oracle/fsr3-shading-pyramid-gpu.mjs",
    url: "/OEngine/tests/oracle/fsr3-shading-pyramid-gpu.mjs",
    entry: "runFsr3ShadingPyramidGpuOracle",
    requiredFeatures: ["texture-formats-tier1"],
    description:
      "Production parallel source lanes against frozen serial SDK math: NPOT, jitter, motion, exposure and f32/f16 products."
  }),
  Object.freeze({
    name: "native-raster-triangle-count",
    file: "OEngine/tests/oracle/native-raster-triangle-count-gpu.mjs",
    url: "/OEngine/tests/oracle/native-raster-triangle-count-gpu.mjs",
    entry: "runNativeRasterTriangleCountGpuOracle",
    requiredLimits: { maxStorageBuffersPerShaderStage: 7 },
    description:
      "Production triangle bucket edges and sides, complete capacity-miss and stale-directory work."
  }),
  Object.freeze({
    name: "fsr3-luma-pyramid",
    file: "OEngine/tests/oracle/fsr3-luma-pyramid-gpu.mjs",
    url: "/OEngine/tests/oracle/fsr3-luma-pyramid-gpu.mjs",
    entry: "runFsr3LumaPyramidGpuOracle",
    requiredFeatures: ["texture-formats-tier1"],
    description:
      "Production local multi-mip reduction against a CPU f32 NPOT reference and frozen per-mip GPU fp16/depth/exposure expectations."
  }),
  Object.freeze({
    name: "temporal-input-contract",
    file: "OEngine/tests/oracle/temporal-input-contract-gpu.mjs",
    url: "/OEngine/tests/oracle/temporal-input-contract-gpu.mjs",
    entry: "runTemporalInputContractGpuOracle",
    requiredLimits: { maxStorageTexturesPerShaderStage: 3 },
    description:
      "Production identity/coverage/jittered motion and shared conservative LOD anchor numeric contract."
  }),
  Object.freeze({
    name: "texture-renderer",
    file: "OEngine/tests/oracle/texture-renderer-gpu.mjs",
    url: "/OEngine/tests/oracle/texture-renderer-gpu.mjs",
    entry: "runTextureRendererGpuOracle",
    allowPrefixes: [
      "examples/assets/three/rendering-lab/dungeon_warkarma.glb",
      "OEngine/src/render/assets/",
      "OEngine/src/assets/web-cook/wasm/vendor/"
    ],
    description: "Complete small authored dungeon Renderer, original 25 textures, 1080p.",
    timeoutMs: 1800000
  }),
  Object.freeze({
    name: "texture-encoder-probe",
    file: "OEngine/tests/oracle/texture-encoder-probe-gpu.mjs",
    url: "/OEngine/tests/oracle/texture-encoder-probe-gpu.mjs",
    entry: "runTextureEncoderProbeGpuOracle",
    requiredFeatures: ["texture-compression-bc", "timestamp-query"],
    allowPrefixes: [".local/texture-design-spark/src/"],
    description:
      "T4.0 isolated pinned external Spark 1K/2K/4K encode cost/quality/output ownership probe; never a production owner.",
    timeoutMs: 300000
  }),
  Object.freeze({
    name: "lighting-product-inspection",
    file: "OEngine/tests/oracle/lighting-product-inspection-gpu.mjs",
    url: "/OEngine/tests/oracle/lighting-product-inspection-gpu.mjs",
    entry: "runLightingProductInspectionGpuOracle",
    allowPrefixes: ["OEngine/src/render/assets/"],
    requiredFeatures: ["timestamp-query"],
    description: "Untimed real GPU occupancy, compact ranges and list-length accounting for L3.3.",
    timeoutMs: 180000
  }),
  Object.freeze({
    name: "lighting-dynamics",
    file: "OEngine/tests/oracle/native-surface-acceptance-gpu.mjs",
    url: "/OEngine/tests/oracle/native-surface-acceptance-gpu.mjs",
    entry: "runLightingDynamicsGpuOracle",
    allowPrefixes: ["OEngine/src/render/assets/"],
    requiredFeatures: ["timestamp-query"],
    description: "Targeted retained light parameter updates, add/remove/reorder and independent colored HDR.",
    timeoutMs: 180000
  }),
  Object.freeze({
    name: "lighting-acceptance",
    file: "OEngine/tests/oracle/native-surface-acceptance-gpu.mjs",
    url: "/OEngine/tests/oracle/native-surface-acceptance-gpu.mjs",
    entry: "runLightingAcceptanceGpuOracle",
    allowPrefixes: ["OEngine/src/render/assets/"],
    requiredFeatures: ["timestamp-query"],
    description:
      "L3.3 same-workload production local light matrix, low coverage, dynamic publication and independent HDR.",
    timeoutMs: 1800000
  }),
  Object.freeze({
    name: "local-light-integration",
    file: "OEngine/tests/oracle/native-surface-integration-gpu.mjs",
    url: "/OEngine/tests/oracle/native-surface-integration-gpu.mjs",
    entry: "runLocalLightIntegrationGpuOracle",
    allowPrefixes: [".local/extreme-web-asset/"],
    requiredFeatures: ["texture-compression-bc", "texture-formats-tier1"],
    requiredLimits: { maxStorageBuffersPerShaderStage: 16 },
    description:
      "Native light ABI with all material routes/two binding sets/alpha/Sun/VSM/AO/Temporal/FSR and resource-limit continuation.",
    timeoutMs: 180000
  }),
  Object.freeze({
    name: "local-light-epochs",
    file: "OEngine/tests/oracle/native-surface-integration-gpu.mjs",
    url: "/OEngine/tests/oracle/native-surface-integration-gpu.mjs",
    entry: "runLocalLightEpochGpuOracle",
    allowPrefixes: [".local/extreme-web-asset/"],
    requiredFeatures: ["texture-compression-bc", "texture-formats-tier1"],
    requiredLimits: { maxStorageBuffersPerShaderStage: 16 },
    description: "Local-light old epoch teardown, rejection and complete new device reconstruction.",
    timeoutMs: 180000
  }),
  Object.freeze({
    name: "local-light-native",
    file: "OEngine/tests/oracle/local-light-native-gpu.mjs",
    url: "/OEngine/tests/oracle/local-light-native-gpu.mjs",
    entry: "runLocalLightNativeGpuOracle",
    requiredFeatures: ["timestamp-query"],
    allowPrefixes: ["OEngine/src/render/assets/"],
    description:
      "L3.2 sole production generator/product/native consumer on real winner/material/Sun/VSM/IBL/AO/Temporal providers.",
    timeoutMs: 240000
  }),
  Object.freeze({
    name: "local-light-cost",
    file: "OEngine/tests/oracle/local-light-native-gpu.mjs",
    url: "/OEngine/tests/oracle/local-light-native-gpu.mjs",
    entry: "runLocalLightCostGpuOracle",
    requiredFeatures: ["timestamp-query"],
    allowPrefixes: ["OEngine/src/render/assets/"],
    description: "L3.1 alternating same-work DIRECT/SPARSE generator+native Surface 1080p cost.",
    timeoutMs: 900000
  }),
  Object.freeze({
    name: "local-light-work",
    file: "OEngine/tests/oracle/local-light-work-gpu.mjs",
    url: "/OEngine/tests/oracle/local-light-work-gpu.mjs",
    entry: "runLocalLightWorkGpuOracle",
    description:
      "L3.1 isolated local-light count/scan/scatter, complete overflow, staged DB abort/retry and independent support coverage.",
    timeoutMs: 180000
  }),
  Object.freeze({
    name: "lighting-support",
    file: "OEngine/tests/oracle/native-surface-acceptance-gpu.mjs",
    url: "/OEngine/tests/oracle/native-surface-acceptance-gpu.mjs",
    entry: "runLightingSupportGpuOracle",
    allowPrefixes: ["OEngine/src/render/assets/"],
    requiredFeatures: ["timestamp-query"],
    description:
      "L3.0 actual production HDR support at finite-radius, offscreen, unbounded, huge Spot and near crossings.",
    timeoutMs: 180000
  }),
  Object.freeze({
    name: "lighting-low-coverage",
    file: "OEngine/tests/oracle/native-surface-acceptance-gpu.mjs",
    url: "/OEngine/tests/oracle/native-surface-acceptance-gpu.mjs",
    entry: "runLightingLowCoverageGpuOracle",
    allowPrefixes: ["OEngine/src/render/assets/"],
    requiredFeatures: ["timestamp-query"],
    description:
      "L3.0 same 1080p production scene/material/quality at far camera, 0/1/4/8/16/32 raw 120-frame baseline.",
    timeoutMs: 240000
  }),
  Object.freeze({
    name: "lighting-baseline",
    file: "OEngine/tests/oracle/native-surface-acceptance-gpu.mjs",
    url: "/OEngine/tests/oracle/native-surface-acceptance-gpu.mjs",
    entry: "runLightingBaselineGpuOracle",
    allowPrefixes: ["OEngine/src/render/assets/"],
    requiredFeatures: ["timestamp-query"],
    description:
      "L3.0 unchanged production Lighting, 1080p, 0..1024 Point/Spot/mixed sparse/overlap, independent HDR and raw timestamps.",
    timeoutMs: 900000
  }),
  Object.freeze({
    name: "lighting-boundaries",
    file: "OEngine/tests/oracle/lighting-boundaries-gpu.mjs",
    url: "/OEngine/tests/oracle/lighting-boundaries-gpu.mjs",
    entry: "runLightingBoundariesGpuOracle",
    description: "L3.0 independent boundary expectations evaluated by actual LightDatabase WGSL helpers.",
    timeoutMs: 120000
  }),
  Object.freeze({
    name: "geometry-shadow-view",
    file: "OEngine/tests/oracle/geometry-shadow-view-gpu.mjs",
    url: "/OEngine/tests/oracle/geometry-shadow-view-gpu.mjs",
    entry: "runGeometryShadowViewGpuOracle",
    requiredFeatures: ["timestamp-query"],
    allowPrefixes: ["OEngine/src/render/assets/", ".local/extreme-web-asset/"],
    requiredLimits: { maxStorageBuffersPerShaderStage: 16 },
    description:
      "Actual Renderer off-camera caster, native alpha, visible receiver HDR and shadow abort/retry.",
    timeoutMs: 180_000
  }),
  Object.freeze({
    name: "geometry-budgeted-residency",
    file: "OEngine/tests/oracle/geometry-budgeted-residency-gpu.mjs",
    url: "/OEngine/tests/oracle/geometry-budgeted-residency-gpu.mjs",
    entry: "runGeometryBudgetedResidencyGpuOracle",
    requiredLimits: { maxStorageBuffersPerShaderStage: 16, maxStorageBufferBindingSize: 268435456 },
    description:
      "Budget/profile boundary bank accesses, true pressure, pinned coarse coverage and fair delayed uploads.",
    timeoutMs: 180_000
  }),
  Object.freeze({
    name: "native-surface-multi-product-production",
    file: "OEngine/tests/oracle/native-surface-production-gpu.mjs",
    url: "/OEngine/tests/oracle/native-surface-production-gpu.mjs",
    entry: "runNativeSurfaceMultiProductProductionGpuOracle",
    allowPrefixes: [
      ".local/extreme-web-asset/",
      "OEngine/src/render/assets/",
      "OEngine/src/assets/web-cook/wasm/vendor/",
      "validation/tools/dungeon-gpu-audit.mjs"
    ],
    requiredFeatures: ["texture-formats-tier1"],
    requiredLimits: { maxStorageBuffersPerShaderStage: 16 },
    description:
      "Actual Renderer with two same-revision Products, abort/retry, alpha/Temporal and all-source device recovery.",
    timeoutMs: 240_000
  }),
  Object.freeze({
    name: "native-surface-acceptance",
    file: "OEngine/tests/oracle/native-surface-acceptance-gpu.mjs",
    url: "/OEngine/tests/oracle/native-surface-acceptance-gpu.mjs",
    entry: "runNativeSurfaceAcceptanceGpuOracle",
    allowPrefixes: ["OEngine/src/render/assets/"],
    requiredFeatures: ["timestamp-query"],
    description:
      "S3 actual Renderer 1080p high coverage Standard/coat/custom/Unlit, 4/8/32 lights and 1/8/32 native programs, HDR oracle and timings.",
    note: "Generated scene complements authored Showcase image acceptance; renderer negotiates its own complete device profile.",
    timeoutMs: 600000
  }),
  Object.freeze({
    name: "native-surface-product-production",
    file: "OEngine/tests/oracle/native-surface-production-gpu.mjs",
    url: "/OEngine/tests/oracle/native-surface-production-gpu.mjs",
    entry: "runNativeSurfaceProductProductionGpuOracle",
    allowPrefixes: [
      ".local/extreme-web-asset/",
      "OEngine/src/render/assets/",
      "OEngine/src/assets/web-cook/wasm/vendor/",
      "validation/tools/dungeon-gpu-audit.mjs"
    ],
    requiredLimits: { maxStorageBuffersPerShaderStage: 16 },
    requiredFeatures: ["texture-formats-tier1"],
    description:
      "S2 actual ordinary Scene WASM Product admission, native Visibility/VSM/Surface/Temporal/recovery closure.",
    timeoutMs: 180000
  }),
  Object.freeze({
    name: "native-surface-production",
    file: "OEngine/tests/oracle/native-surface-production-gpu.mjs",
    url: "/OEngine/tests/oracle/native-surface-production-gpu.mjs",
    entry: "runNativeSurfaceProductionGpuOracle",
    allowPrefixes: [
      ".local/extreme-web-asset/",
      "OEngine/src/render/assets/",
      "validation/tools/dungeon-gpu-audit.mjs"
    ],
    requiredLimits: { maxStorageBuffersPerShaderStage: 16 },
    requiredFeatures: ["texture-formats-tier1"],
    description:
      "S2 actual Renderer ownership, native instance publication, winner/HDR/Temporal/FSR, update/abort/retry/resize.",
    note: "Renderer negotiates its own device; oracle captures errors on that real production device. This is a correctness closure, not S3 performance acceptance.",
    timeoutMs: 180000
  }),
  Object.freeze({
    name: "final-pixel-feature-demand",
    file: "OEngine/tests/oracle/native-surface-production-gpu.mjs",
    url: "/OEngine/tests/oracle/native-surface-production-gpu.mjs",
    entry: "runFinalPixelFeatureDemandGpuOracle",
    allowPrefixes: [
      ".local/extreme-web-asset/",
      "OEngine/src/render/assets/",
      "validation/tools/dungeon-gpu-audit.mjs"
    ],
    description:
      "Actual no-Physical-Sun and capability-projected bounded Renderer demand/domain/retirement closure.",
    timeoutMs: 180000
  }),
  Object.freeze({
    name: "native-surface-resource-profile",
    file: "OEngine/tests/oracle/native-surface-integration-gpu.mjs",
    url: "/OEngine/tests/oracle/native-surface-integration-gpu.mjs",
    entry: "runNativeSurfaceResourceProfileGpuOracle",
    allowPrefixes: [".local/extreme-web-asset/"],
    requiredLimits: { maxStorageBuffersPerShaderStage: 16 },
    requiredFeatures: ["texture-compression-bc", "texture-formats-tier1"],
    description:
      "S1 complete Product-geometry resource profile, native sunlight and resident winner input; not VG scene acceptance.",
    timeoutMs: 120000
  }),
  Object.freeze({
    name: "native-surface-device-epoch",
    file: "OEngine/tests/oracle/native-surface-integration-gpu.mjs",
    url: "/OEngine/tests/oracle/native-surface-integration-gpu.mjs",
    entry: "runNativeSurfaceDeviceEpochGpuOracle",
    allowPrefixes: [".local/extreme-web-asset/"],
    description:
      "S1 controlled device destruction and native subsystem reconstruction on two independent device epochs.",
    timeoutMs: 120000
  }),
  Object.freeze({
    name: "surface-workgroup-cost",
    file: "OEngine/tests/oracle/surface-workgroup-cost-gpu.mjs",
    url: "/OEngine/tests/oracle/surface-workgroup-cost-gpu.mjs",
    entry: "runSurfaceWorkgroupCostGpuOracle",
    allowPrefixes: ["OEngine/src/render/assets/"],
    requiredLimits: { maxStorageBuffersPerShaderStage: 16 },
    requiredFeatures: ["texture-compression-bc", "texture-formats-tier1", "timestamp-query"],
    description:
      "Local exact native-chain ABBA for no/intermediate/high triangle reuse; no final-scene performance claim.",
    timeoutMs: 300000
  }),
  Object.freeze({
    name: "native-surface-cost",
    file: "OEngine/tests/oracle/native-surface-integration-gpu.mjs",
    url: "/OEngine/tests/oracle/native-surface-integration-gpu.mjs",
    entry: "runNativeSurfaceCostGpuOracle",
    allowPrefixes: [".local/extreme-web-asset/"],
    requiredLimits: { maxStorageBuffersPerShaderStage: 16 },
    requiredFeatures: ["texture-compression-bc", "texture-formats-tier1", "timestamp-query"],
    description: "S1 isolated 1080p native multi-route/Temporal/FSR cost; not production acceptance.",
    timeoutMs: 180000
  }),
  Object.freeze({
    name: "native-surface-perspective",
    file: "OEngine/tests/oracle/native-surface-integration-gpu.mjs",
    url: "/OEngine/tests/oracle/native-surface-integration-gpu.mjs",
    entry: "runNativeSurfacePerspectiveGpuOracle",
    allowPrefixes: [".local/extreme-web-asset/"],
    requiredLimits: { maxStorageBuffersPerShaderStage: 16 },
    requiredFeatures: ["texture-compression-bc", "texture-formats-tier1"],
    description: "S1 perspective reconstruction, physical sun math and real GPU exposure update.",
    timeoutMs: 120000
  }),
  Object.freeze({
    name: "native-execution-bins",
    file: "OEngine/tests/oracle/native-execution-bins-gpu.mjs",
    url: "/OEngine/tests/oracle/native-execution-bins-gpu.mjs",
    entry: "runNativeExecutionBinsGpuOracle",
    requiredLimits: { maxStorageBuffersPerShaderStage: 16 },
    description: "S1 native pixel execution bins, complete tails, capacity and unique-writer coverage.",
    timeoutMs: 60000
  }),
  Object.freeze({
    name: "native-surface-integration",
    file: "OEngine/tests/oracle/native-surface-integration-gpu.mjs",
    url: "/OEngine/tests/oracle/native-surface-integration-gpu.mjs",
    entry: "runNativeSurfaceIntegrationGpuOracle",
    allowPrefixes: [".local/extreme-web-asset/"],
    requiredLimits: { maxStorageBuffersPerShaderStage: 16 },
    requiredFeatures: ["texture-compression-bc", "texture-formats-tier1"],
    description: "S1 isolated native winner/material/HDR/Temporal/FSR chain; no production cutover.",
    timeoutMs: 120000
  }),
  Object.freeze({
    name: "native-material",
    file: "OEngine/tests/oracle/native-material-gpu.mjs",
    url: "/OEngine/tests/oracle/native-material-gpu.mjs",
    entry: "runNativeMaterialGpuOracle",
    requiredFeatures: ["texture-compression-bc"],
    description:
      "S1 native Standard/Coat/Unlit/custom graph, explicit gradients and immutable publication transactions.",
    timeoutMs: 60000,
    note: "Component only: fixture geometry inputs and linear textures; no production cutover or S1 closure claim."
  }),
  Object.freeze({
    name: "framegraph-lifecycle",
    file: "OEngine/tests/oracle/framegraph-lifecycle-gpu.mjs",
    url: "/OEngine/tests/oracle/framegraph-lifecycle-gpu.mjs",
    entry: "runFrameGraphLifecycleGpuOracle",
    requiredFeatures: ["timestamp-query"],
    description:
      "A0/A1 production compiled executor, pooled/native lifetime, resize binding and diagnostics WGSL.",
    timeoutMs: 60000,
    note: "Real GPU component chain with independent buffer/diagnostic assertions."
  }),
  Object.freeze({
    name: "frame-timing",
    file: "OEngine/tests/oracle/frame-timing-gpu.mjs",
    url: "/OEngine/tests/oracle/frame-timing-gpu.mjs",
    entry: "runFrameTimingGpuOracle",
    requiredFeatures: ["timestamp-query"],
    description: "A0 persistent timer modes, query/marker tax and real GPU span/result assertions.",
    timeoutMs: 60000,
    note: "Production timer components, not a full-frame benchmark."
  }),
  Object.freeze({
    name: "environment-probe",
    file: "tools/gpu-oracle/self-test/environment-probe.mjs",
    url: "/__gpu-oracle/self-test/environment-probe.mjs",
    entry: "runEnvironmentProbe",
    description:
      "Minimal real-GPU smoke test: one compute dispatch, storage-buffer readback, asserted on the CPU.",
    timeoutMs: 60_000,
    note: "Run this first on a new machine or CI runner; it separates harness/driver availability from oracle logic."
  }),
  Object.freeze({
    name: "hzb-conservative",
    file: "OEngine/tests/oracle/hzb-conservative-gpu.mjs",
    url: "/OEngine/tests/oracle/hzb-conservative-gpu.mjs",
    entry: "runConservativeHzbGpuOracle",
    requiredFeatures: ["texture-formats-tier1"],
    description:
      "Exhaustive rg16float half-boundary reduction plus all 1296 HZB footprint rectangles against buildHzbReference.",
    timeoutMs: 180_000,
    note: "Independent CPU reference; strongest numeric oracle in the repository."
  }),
  Object.freeze({
    name: "virtual-geometry-handoff",
    file: "OEngine/tests/oracle/virtual-geometry-handoff-gpu.mjs",
    url: "/OEngine/tests/oracle/virtual-geometry-handoff-gpu.mjs",
    entry: "runVirtualGeometryHandoffGpuOracle",
    requiredLimits: { maxStorageBuffersPerShaderStage: 16 },
    description:
      "VirtualGeometryMeshletWorkCandidate queue/draw-indirect handoff with exact compacted cluster IDs.",
    timeoutMs: 180_000,
    note: "Drives the production owner VirtualGeometryMeshletWorkCandidate from OEngine/.test-dist."
  }),
  Object.freeze({
    name: "geometry-product-scale",
    file: "OEngine/tests/oracle/geometry-product-scale-gpu.mjs",
    url: "/OEngine/tests/oracle/geometry-product-scale-gpu.mjs",
    entry: "runGeometryProductScaleGpuOracle",
    requiredFeatures: ["timestamp-query"],
    requiredLimits: { maxStorageBuffersPerShaderStage: 16 },
    description:
      "Product publication, depth-0/deep forests, instance multiplicity, multi-Product and fail-closed work/abort controls.",
    timeoutMs: 180_000,
    note: "Uses production MultiRuntime, HierarchicalWorkGenerator and MeshletWorkCandidate; no alternative renderer."
  }),
  Object.freeze({
    name: "geometry-scale-production",
    file: "OEngine/tests/oracle/geometry-scale-production-gpu.mjs",
    url: "/OEngine/tests/oracle/geometry-scale-production-gpu.mjs",
    entry: "runGeometryScaleProductionGpuOracle",
    allowPrefixes: ["OEngine/src/render/assets/"],
    requiredLimits: { maxStorageBuffersPerShaderStage: 16 },
    requiredFeatures: ["texture-formats-tier1", "timestamp-query"],
    timeoutMs: 300000,
    description:
      "Actual Renderer 1080p exhaustive raster/winner coverage for 10k/100k procedural instances and 8/66 Products.",
    note: "Resident position-only Unlit scale fixture, not authored material/streaming quality or historical speedup."
  }),
  Object.freeze({
    name: "virtual-geometry-instance-culling",
    file: "OEngine/tests/oracle/virtual-geometry-instance-culling-gpu.mjs",
    url: "/OEngine/tests/oracle/virtual-geometry-instance-culling-gpu.mjs",
    entry: "runVirtualGeometryInstanceCullingGpuOracle",
    requiredLimits: { maxStorageBuffersPerShaderStage: 16 },
    description:
      "HierarchicalWorkGenerator root/hierarchy kernels over 20 camera frames, with the old double-transform false rejection as negative control.",
    timeoutMs: 180_000,
    note: "Drives the production owner HierarchicalWorkGenerator from OEngine/.test-dist."
  }),
  Object.freeze({
    name: "self-test-wrong-kernel",
    file: "tools/gpu-oracle/self-test/hzb-conservative-wrong-kernel.mjs",
    url: "/__gpu-oracle/self-test/hzb-conservative-wrong-kernel.mjs",
    entry: "runWrongKernelHzbOracle",
    requiredFeatures: ["texture-formats-tier1"],
    description:
      "Negative control: the HZB reduction oracle with a deliberately non-conservative GPU kernel.",
    timeoutMs: 180_000,
    negativeControl: true,
    note: "Must FAIL. Proves the harness propagates failures produced by real GPU output. Never a production oracle."
  })
]);

export function findOracle(name) {
  return oracles.find((oracle) => oracle.name === name) ?? null;
}
