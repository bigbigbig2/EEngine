---
name: eengine-code-style
description: "Use when writing, modifying, reviewing, or refactoring EEngine TypeScript, WGSL, WebGPU renderer, FrameGraph, GPU ABI, shader-generator, Surface, lighting, temporal, or residency code under OEngine/src; apply the project's readable, GPU-auditable style without triggering for ordinary documentation or unrelated application code."
metadata:
  short-description: "Readable, auditable TypeScript and WGSL for EEngine"
---

# EEngine code style

EEngine is a performance-oriented WebGPU renderer. When this skill applies,
optimize decisions in this order:

1. Correctness.
2. GPU auditability.
3. Performance.
4. Human readability.
5. Locality.
6. Abstraction.

Readability is more important than terseness. Locality is more important than
generic abstraction. Explicit GPU state is preferred over generic wrappers.
Apply the guidance silently during normal coding; do not emit a style report,
checklist, or governance artifact unless the user explicitly asks for a style
review.

## Scope and workflow

- Prefer this skill for touched code in `OEngine/src/**/*.ts`,
  `OEngine/src/**/*.wgsl`, `OEngine/src/shaders/**/*.ts`, `render`, `gpu`,
  `framegraph`, Surface Work, Appearance, Lighting, Temporal, VSM, FSR3,
  GPU Scene, and residency paths.
- Read the relevant owner, ABI, and nearby producer/consumer before editing.
  Preserve the existing single renderer path, FrameGraph ownership, resource
  lifetime, and GPU data flow.
- Apply a touched-code policy: format and refactor new code, changed code, and
  code directly required by the current change. Do not format the repository or
  unrelated legacy files unless the user explicitly requests it.
- Use existing Prettier/ESLint configuration when the repository has one. This
  skill does not replace a formatter, add dependencies, or require a new lint
  configuration. Do not make full-repository formatting part of ordinary work.
- Do not impose mandatory full tests or reports for every edit. Run checks that
  are appropriate to the requested change and state what was or was not run.

## TypeScript rules

- Do not minify handwritten production TypeScript. Use one statement per line.
- Use braces for `if`, `else`, `for`, and `while`, including simple bodies in
  GPU-facing code. Avoid runs of `if (condition) return;` on one line.
- Keep constructors, `destroy`, `addToGraph`, encoding, pipeline creation, and
  bind-group construction vertically readable. Separate resource creation,
  bindings, dispatch, and lifetime operations so a reviewer can audit them.
- Use descriptive local names such as `buffer`, `record`, `resource`,
  `pipeline`, and `geometryRecord`. Keep standard renderer terms such as GPU,
  ABI, UV, LOD, HZB, VSM, BRDF, and IBL.
- Keep FrameGraph input/output declarations, resource creation, pass encoding,
  dependencies, and product return close enough to inspect as one local flow.
- Do not introduce `Manager`, `Coordinator`, `Service`, `Controller`,
  `Processor`, `Factory`, or similar layers solely to shorten a pass class.
  Do not refactor GPU hot-path code solely to reduce function length.

## WebGPU descriptors and ABI

- Format `GPUBufferDescriptor`, `GPUTextureDescriptor`, bind-group layouts and
  descriptors, pipeline descriptors, render/compute passes, and FrameGraph
  resource descriptors vertically. Keep `binding`, visibility/access, usage,
  format, lifetime, and resource visibly comparable.
- Bind-group entries should be easy to compare with the shader declaration.
  Keep a literal binding number when its local correspondence with WGSL is
  clearer than a symbolic wrapper; GPU ABI numbers are allowed to remain local
  literals.
- A real ABI owner must define stride, record size, field/word count, bit
  meaning, and offsets. Do not duplicate values such as `24 * 4` in unrelated
  owners when a named ABI constant already exists.
- Preserve explicit typed buffers, loops, bit operations, indirect dispatch,
  and resource state in performance-sensitive paths. Do not replace them with
  generic collections, callback chains, or wrapper objects merely for style.

## WGSL rules

- Handwritten WGSL must be fully readable. Never generate or commit minified
  WGSL in a production shader string.
- Put spaces around operators and use one declaration or statement per line.
  Use braces for control flow and make early returns block-shaped.
- Format structs vertically with one member per line and a trailing comma.
- Group bindings by semantic role, with short comments such as `Frame state`,
  `Surface input`, and `Output`. Leave binding numbers visible for ABI audit.
- Split a WGSL helper when it has a real mathematical or pipeline meaning,
  avoids repeated work, or isolates a complex branch. Do not create helpers
  named `getA`, `doThing`, or `helper1` merely to reduce line count.
- Keep bounds checks, atomics, barriers, storage access, and workgroup behavior
  explicit. Read the local WebGPU skill when a change depends on API validity,
  WGSL layout, synchronization, or feature support.

## Generated WGSL

Distinguish handwritten WGSL from WGSL produced by a TypeScript generator. A
generator may compose source fragments, but the generator itself must remain
readable. Prefer named sections such as `declarations`, `helpers`, and `body`,
then compose them with clear template-string paragraphs. Avoid deeply nested
`${...}` expressions, chained `map(...).join(...)` source construction, and
large conditional template expressions. Do not add a template library solely
for formatting.

## Renderer-specific judgment

GPU code is not ordinary business code. Keep producer, consumer, capacity,
overflow, and retirement visible. Prefer a local `addToGraph()` flow when it
lets a reviewer see resources, pipeline, bindings, dispatch, dependencies, and
products together. Split only across real owner boundaries such as shader
generation, resource ownership, pipeline caching, or an independent pass.

Do not change Surface, FrameGraph, material, or renderer architecture merely to
make the code look cleaner. Do not restore a retired path or create an adapter
bridge to preserve a replaced ABI. Style improvements must preserve the
project's GPU architecture and performance intent.

## Focused references

- Read [references/typescript.md](references/typescript.md) for detailed
  TypeScript and descriptor examples.
- Read [references/wgsl.md](references/wgsl.md) when writing handwritten WGSL
  or a WGSL generator.
- Read [references/examples.md](references/examples.md) for bad/good examples
  taken from the current EEngine Surface and SignalStore sources. These are
  style examples only; do not edit the production files just to match them.
