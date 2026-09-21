/**
 * Canonical browser harness surface for validation cases.
 *
 * Cases own scenario setup and assertions; this module owns the shared
 * protocol, GPU diagnostics, and production observer contracts. The source
 * implementations live beside this facade so generated bundles keep one
 * copy of each lifecycle primitive.
 */
export * from "./protocol.ts";
export * from "./webgpu.ts";
export * from "./production-gpu-observer.ts";
