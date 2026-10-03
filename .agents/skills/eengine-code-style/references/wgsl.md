# WGSL and shader-generator guidance

Use this reference when editing a handwritten WGSL string or a TypeScript
generator such as `surface_cell_classify.ts` and
`surface_cell_production_facts.ts`.

## Handwritten WGSL

Keep declarations, guards, and loops explicit:

```wgsl
struct SignalStoreSettings {
  request_count: u32,
  entry_count: u32,
  generation: u32,
  reserved: u32,
}

// Frame state
@group(0) @binding(0)
var<uniform> settings: SignalStoreSettings;

// Requests
@group(0) @binding(1)
var<storage, read> requests: array<u32>;

@compute @workgroup_size(64)
fn publish(@builtin(global_invocation_id) id: vec3u) {
  let record = id.x;

  if (record >= settings.request_count) {
    return;
  }

  let source = record * 16u;
  let target = record * settings.entry_count;

  for (var word = 0u; word < 10u; word++) {
    // Keep the key copy visible to the ABI audit.
    requests[target + word] = requests[source + word];
  }
}
```

Use spaces around operators, one statement per line, braces around control
flow, and a trailing comma in structs. Preserve bounds checks before indexing
storage arrays. Keep atomics, workgroup barriers, and storage access explicit;
do not hide synchronization in a generic helper.

## Binding groups

Group bindings by semantic role and leave the binding number visible:

```wgsl
// Surface input
@group(0) @binding(1)
var<storage, read> geometry: array<vec4f>;

@group(0) @binding(2)
var<storage, read> fields: array<vec2u>;

// Output
@group(0) @binding(3)
var<storage, read_write> packets: array<vec2u>;
```

The comments are useful when a pass has many bindings. They must describe the
data role, not repeat the variable name.

## Meaningful helpers

Good helpers isolate a mathematical or pipeline concept:

- `decodeVisibility`
- `loadGeometry`
- `evaluateDirectLighting`
- `environmentDiffuse`
- `packetStore`

Avoid helpers whose only purpose is to remove a line or hide an ABI access,
such as `getA`, `doThing`, or `processValue`. A long shader function is fine
when it is one coherent GPU stage.

## Generated WGSL

The TypeScript generator is source code and must be readable even when its
output is assembled dynamically. Prefer named fragments:

```ts
const declarations = buildDeclarations(profile);
const helpers = buildHelpers(profile);
const entryPoint = buildEntryPoint(profile);

return `
${declarations}

${helpers}

${entryPoint}
`;
```

Avoid a single nested template expression such as:

```text
`${a}${b}${condition ? `${c}${d}` : ""}${items.map(...).join("")}`
```

Build conditional fragments in named variables first. Do not add a template
library solely to format WGSL.

## GPU audit points

When changing WGSL, keep these visible in the same local region:

- the ABI declaration and its TypeScript descriptor;
- the bounds check and the capacity source;
- the producer/consumer order and any required separate dispatch;
- the unit or color-space contract for values;
- the fallback and overflow behavior;
- the workgroup size and indirect dispatch source.

Read the repository `webgpu` skill for API validity, memory layout, feature
support, atomics, barriers, or uniformity questions. This style skill does not
replace that technical review.
