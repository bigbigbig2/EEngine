export type ExampleStatus = "Integrated" | "In progress" | "Gate" | "Validation";

export interface ExampleCatalogEntry {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly status: ExampleStatus;
  readonly tags: readonly string[];
  readonly route: string;
  readonly sourcePath: string;
  readonly scene: "showcase" | "packed" | "visibility" | "lighting" | "temporal" | "benchmark";
  readonly stats: readonly [string, string][];
}

export const exampleCatalog = {
  renderingLab: {
    id: "Showcase 00",
    title: "Rendering Lab · Integrated Quality Fixture",
    description:
      "A controlled production-path scene combining a traceable static three.js model with mirror/rough floors, contact geometry, thin poles, emissive markers, clustered lights, IBL, shadows, GTAO, SSR and temporal rendering.",
    status: "Integrated",
    tags: ["Quality fixture", "PBR / IBL", "Full pipeline"],
    route: "rendering-lab/",
    sourcePath: "examples/rendering-lab",
    scene: "showcase",
    stats: [["Subject", "Dungeon · Warkarma"], ["Surfaces", "Mirror / rough / contact"], ["Evidence", "Q00 GPU + temporal"]]
  },
  renderingLabPipeline: {
    id: "Rendering Lab 00",
    title: "Rendering Lab · GPU Pipeline",
    description:
      "A focused debug fixture for the GPU-ready asset to Surface path: cooker packages, residency, packed instances, hierarchy/SSE/Cone/HZB, GPU work generation, indirect RasterWork, VisibilityKey and material resolve.",
    status: "Validation",
    tags: ["Performance", "GPU-driven", "Debug panel"],
    route: "rendering-lab/?mode=pipeline",
    sourcePath: "examples/rendering-lab",
    scene: "visibility",
    stats: [["Model", "Dungeon · Warkarma"], ["Effects", "Advanced effects off"], ["Evidence", "Async GPU counters"]]
  },
  integratedShowcase: {
    id: "Showcase 01",
    title: "Cyberpunk City · Integrated Pipeline",
    description:
      "A production-path GLB scene combining packed geometry, hierarchy visibility, PBR materials, clustered lights, IBL, shadows, temporal rendering, and unified debug views.",
    status: "Integrated",
    tags: ["GLB", "PBR / IBL", "Full pipeline"],
    route: "integrated-showcase/",
    sourcePath: "examples/integrated-showcase",
    scene: "showcase",
    stats: [["Input", "68 static primitives"], ["Lighting", "IBL + clustered + CSM"], ["Diagnostics", "Unified debug view"]]
  },
  packedScene: {
    id: "R2-D",
    title: "Packed Instances · 100K",
    description:
      "Bulk scene upload, compact GPU tables, and explicit transform/material patches in a GPU producer-to-consumer loop.",
    status: "Integrated",
    tags: ["GPU-driven", "Packed Scene", "WebGPU"],
    route: "r2-packed-scene/",
    sourcePath: "examples/r2-packed-scene",
    scene: "packed",
    stats: [["Scale", "1K / 10K / 100K"], ["Submission", "GPU compact → indirect"], ["Overflow", "Explicitly reported"]]
  },
  hierarchicalLod: {
    id: "R3-B",
    title: "Hierarchical LOD & Work Generation",
    description:
      "Inspect instance culling, cluster frustum/SSE selection, and bounded hierarchy work queues over resident GPU tables.",
    status: "Integrated",
    tags: ["Hierarchy", "SSE", "GPU work queue"],
    route: "r3-hierarchical-work-generation/",
    sourcePath: "examples/r3-hierarchical-work-generation",
    scene: "packed",
    stats: [["Selection", "Hierarchy + SSE"], ["Consumer", "Hardware raster work"], ["Evidence", "GPU/CPU selected set"]]
  },
  hardwareVisibility: {
    id: "R4-A",
    title: "Hardware Visibility",
    description:
      "Inspect VisibilityKey, reverse-Z depth, alpha-tested geometry, and the production debug resolve path.",
    status: "Integrated",
    tags: ["VisibilityKey", "Reverse-Z", "Debug views"],
    route: "r4-debug-resolve/",
    sourcePath: "examples/r4-debug-resolve",
    scene: "visibility",
    stats: [["Opaque submit", "1 drawIndirect"], ["Key", "Packed VisibilityKey"], ["Failure policy", "Fail-visible"]]
  },
  clusteredLights: {
    id: "FX-02",
    title: "Clustered Direct Lighting",
    description:
      "Validate bounded point and spot light lists, overflow fallback, and production Surface direct lighting.",
    status: "Integrated",
    tags: ["Lighting", "Bounded lists", "Surface"],
    route: "r5-clustered-direct/",
    sourcePath: "examples/r5-clustered-direct",
    scene: "lighting",
    stats: [["Light count", "0 → 1,024"], ["Queue", "Bounded"], ["Pressure behavior", "Explicit fallback"]]
  },
  temporal: {
    id: "FX-06B",
    title: "Temporal & Upscaling",
    description:
      "Inspect history validity, motion/disocclusion, render scale, and final output-resolution composition.",
    status: "In progress",
    tags: ["TAA", "Upscaling", "History"],
    route: "r5-final-temporal/",
    sourcePath: "examples/r5-final-temporal",
    scene: "temporal",
    stats: [["History", "Submit-aware ping-pong"], ["Invalidation", "Cut / resize / scale"], ["Path", "FX-06B"]]
  },
  benchmarkA: {
    id: "Benchmark A",
    title: "Teapot · 160K Contract",
    description:
      "Fixed Teapot, LOD, 160K layout, and camera workload matching the minimum compute-rasterizer baseline.",
    status: "Gate",
    tags: ["Fixed recipe", "Performance", "Smoke profile"],
    route: "benchmark-a/?profile=smoke",
    sourcePath: "examples/benchmark-a",
    scene: "benchmark",
    stats: [["Instances", "160,000"], ["Profile", "Smoke / Full"], ["Output", "Counters + timings"]]
  },
  benchmarkB: {
    id: "Benchmark B",
    title: "Damaged Helmet · PBR/IBL",
    description:
      "Fixed Damaged Helmet model, material textures, environment input, and 15,625-instance layout.",
    status: "Gate",
    tags: ["PBR", "IBL", "Fixed recipe"],
    route: "benchmark-b/?profile=smoke",
    sourcePath: "examples/benchmark-b",
    scene: "benchmark",
    stats: [["Instances", "15,625"], ["Material", "Textured PBR"], ["Profile", "Smoke / Full"]]
  },
  benchmarkC: {
    id: "Benchmark C",
    title: "Engine Generality Contract",
    description:
      "Multiple geometries and materials, alpha testing, dynamic lights, and transform patches on one render pipeline.",
    status: "Gate",
    tags: ["Generality", "Dynamic scene", "Fixed recipe"],
    route: "benchmark-c/?profile=smoke",
    sourcePath: "examples/benchmark-c",
    scene: "benchmark",
    stats: [["Input", "Heterogeneous"], ["Dynamic data", "Lights + transforms"], ["Profile", "Smoke / Full"]]
  },
  observability: {
    id: "R0",
    title: "Renderer Observability",
    description:
      "Initialize a real GraphicsContext and report adapter, CPU, submit, readback, upload, and counter evidence.",
    status: "Validation",
    tags: ["Diagnostics", "Counters", "Environment"],
    route: "r0-observability/",
    sourcePath: "examples/r0-observability",
    scene: "benchmark",
    stats: [["Environment", "Adapter + limits"], ["Frame evidence", "CPU / submit"], ["I/O", "Upload / readback"]]
  },
  surfaceDebug: {
    id: "FX-01",
    title: "Surface Debug Views",
    description:
      "Inspect Surface attachments, background, velocity, reactive, and history validity on a 2×3 packed material board.",
    status: "Integrated",
    tags: ["Diagnostics", "Surface", "Debug views"],
    route: "r5-surface-debug/",
    sourcePath: "examples/r5-surface-debug",
    scene: "visibility",
    stats: [["Material board", "2 × 3"], ["Output", "Surface debug views"], ["Feature off", "Zero debug work"]]
  }
} as const satisfies Record<string, ExampleCatalogEntry>;
