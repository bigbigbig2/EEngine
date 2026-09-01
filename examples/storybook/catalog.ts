export type ExampleStatus = "Integrated" | "In progress" | "Gate" | "Validation";
export type ExamplePageStatus = ExampleStatus | "Interactive";

export interface ExampleCatalogEntry {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly status: ExampleStatus;
  readonly tags: readonly string[];
  readonly route: string;
  readonly sourcePath: string;
  readonly scene: "packed" | "visibility" | "lighting" | "temporal" | "benchmark";
  readonly stats: readonly [string, string][];
}

export const exampleCatalog = {
  packedScene: {
    id: "R2-D",
    title: "Packed Instances · 100K",
    description:
      "Bulk scene upload、紧凑 GPU 表与显式 transform/material patch，形成 GPU producer → consumer 闭环。",
    status: "Integrated",
    tags: ["GPU-driven", "Packed Scene", "WebGPU"],
    route: "r2-packed-scene/",
    sourcePath: "examples/r2-packed-scene",
    scene: "packed",
    stats: [["实例规模", "1K / 10K / 100K"], ["提交路径", "GPU compact → indirect"], ["溢出", "显式报告"]]
  },
  hierarchicalLod: {
    id: "R3-B",
    title: "Hierarchical LOD & Work Generation",
    description:
      "在 resident GPU tables 上观察 Instance Cull、Cluster Frustum/SSE 与 bounded hierarchy work queues。",
    status: "Integrated",
    tags: ["Hierarchy", "SSE", "GPU work queue"],
    route: "r3-hierarchical-work-generation/",
    sourcePath: "examples/r3-hierarchical-work-generation",
    scene: "packed",
    stats: [["选择方式", "Hierarchy + SSE"], ["消费者", "Hardware raster work"], ["证据", "GPU/CPU selected-set"]]
  },
  hardwareVisibility: {
    id: "R4-A",
    title: "Hardware Visibility",
    description:
      "检查 VisibilityKey、reverse-Z depth、alpha-tested geometry 与 production debug resolve。",
    status: "Integrated",
    tags: ["VisibilityKey", "Reverse-Z", "Debug views"],
    route: "r4-debug-resolve/",
    sourcePath: "examples/r4-debug-resolve",
    scene: "visibility",
    stats: [["Opaque submit", "1 drawIndirect"], ["Key", "Packed VisibilityKey"], ["失败策略", "Fail-visible"]]
  },
  clusteredLights: {
    id: "FX-02",
    title: "Clustered Direct Lighting",
    description:
      "验证 bounded point/spot light lists、overflow fallback 与生产 Surface direct lighting。",
    status: "Integrated",
    tags: ["Lighting", "Bounded lists", "Surface"],
    route: "r5-clustered-direct/",
    sourcePath: "examples/r5-clustered-direct",
    scene: "lighting",
    stats: [["灯光规模", "0 → 1,024"], ["队列", "Bounded"], ["压力行为", "Explicit fallback"]]
  },
  temporal: {
    id: "FX-06B",
    title: "Temporal & Upscaling",
    description:
      "观察 history validity、motion/disocclusion、render scale 与最终输出分辨率 composition。",
    status: "In progress",
    tags: ["TAA", "Upscaling", "History"],
    route: "r5-final-temporal/",
    sourcePath: "examples/r5-final-temporal",
    scene: "temporal",
    stats: [["历史", "Submit-aware ping-pong"], ["失效", "Cut / resize / scale"], ["主线", "FX-06B"]]
  },
  benchmarkA: {
    id: "Benchmark A",
    title: "Teapot · 160K Contract",
    description:
      "冻结 three.js Compute Rasterizer 最低线的 Teapot、LOD、160K layout 与相机输入。",
    status: "Gate",
    tags: ["Fixed recipe", "Performance", "Smoke profile"],
    route: "benchmark-a/?profile=smoke",
    sourcePath: "examples/benchmark-a",
    scene: "benchmark",
    stats: [["实例", "160,000"], ["Profile", "Smoke / Full"], ["输出", "Counters + timings"]]
  },
  benchmarkB: {
    id: "Benchmark B",
    title: "Damaged Helmet · PBR/IBL",
    description:
      "冻结 Damaged Helmet、材质纹理、环境输入与 15,625 instance layout。",
    status: "Gate",
    tags: ["PBR", "IBL", "Fixed recipe"],
    route: "benchmark-b/?profile=smoke",
    sourcePath: "examples/benchmark-b",
    scene: "benchmark",
    stats: [["实例", "15,625"], ["材质", "Textured PBR"], ["Profile", "Smoke / Full"]]
  },
  benchmarkC: {
    id: "Benchmark C",
    title: "Engine Generality Contract",
    description:
      "同一主管线上的多 geometry/material、alpha-tested、动态灯光与 transform patch。",
    status: "Gate",
    tags: ["Generality", "Dynamic scene", "Fixed recipe"],
    route: "benchmark-c/?profile=smoke",
    sourcePath: "examples/benchmark-c",
    scene: "benchmark",
    stats: [["输入", "Heterogeneous"], ["动态", "Lights + transforms"], ["Profile", "Smoke / Full"]]
  },
  observability: {
    id: "R0",
    title: "Renderer Observability",
    description:
      "初始化真实 GraphicsContext，导出 adapter、CPU、submit、readback、upload 与 counter 观测结果。",
    status: "Validation",
    tags: ["Diagnostics", "Counters", "Environment"],
    route: "r0-observability/",
    sourcePath: "examples/r0-observability",
    scene: "benchmark",
    stats: [["环境", "Adapter + limits"], ["帧证据", "CPU / submit"], ["I/O", "Upload / readback"]]
  },
  surfaceDebug: {
    id: "FX-01",
    title: "Surface Debug Views",
    description:
      "通过 2×3 Packed 材质板检查 Surface attachments、背景、Velocity、Reactive 与 History Validity。",
    status: "Integrated",
    tags: ["Diagnostics", "Surface", "Debug views"],
    route: "r5-surface-debug/",
    sourcePath: "examples/r5-surface-debug",
    scene: "visibility",
    stats: [["材质板", "2 × 3"], ["输出", "Surface debug views"], ["关闭语义", "Zero debug work"]]
  }
} as const satisfies Record<string, ExampleCatalogEntry>;
