# TypeScript and WebGPU descriptor guidance

Use this reference when a touched file creates GPU resources, encodes a
FrameGraph pass, or owns GPU lifetime. The examples are based on the current
Surface, FieldStore, and SignalStore sources.

## Readable control flow

Keep guards and cleanup visible:

```ts
destroy(): void {
  if (this.destroyed) {
    return;
  }

  this.destroyed = true;

  for (const buffer of this.buffers) {
    buffer.destroy();
  }

  if (this.handle) {
    this.accounting!.destroyed(this.handle);
  }
}
```

Do not compress the same lifecycle into a single line. The extra vertical space
makes ownership, idempotence, and retirement behavior inspectable.

## Resource creation

Keep descriptor fields aligned with the resource's ABI and lifetime:

```ts
const signalStoreBuffer = device.createBuffer({
  label: "Surface/SignalStore entries",
  size: capacity.bytes,
  usage: GPUBufferUsage.STORAGE |
    GPUBufferUsage.COPY_DST |
    GPUBufferUsage.COPY_SRC,
});
```

For a `createBindGroupLayout` or `createBindGroup`, expand `entries` when the
pass has more than a trivial binding. A reviewer should be able to compare each
binding with the WGSL declaration without mentally unpacking a dense object.

```ts
const group = device.createBindGroup({
  layout,
  entries: [
    {
      binding: 0,
      resource: {
        buffer: settingsBuffer,
      },
    },
    {
      binding: 1,
      resource: {
        buffer: geometryBuffer,
      },
    },
  ],
});
```

Keep an ABI literal such as `binding: 17` when it directly matches
`@binding(17)` in the adjacent shader. Do not replace every literal with a
symbol that hides the correspondence.

## FrameGraph locality

A pass should make its local data flow visible:

```ts
const node = graph.add("Surface/SignalStore publish", data, (frame, resources, context) => {
  const command = context.encoder as ShadeGPUCommandContext;
  const requestBuffer = resources.get(frame.requests) as GPUBuffer;

  const group = device.createBindGroup({
    layout: publishPipeline.getBindGroupLayout(0),
    entries: [
      {
        binding: 0,
        resource: {
          buffer: settingsBuffer,
        },
      },
      {
        binding: 1,
        resource: {
          buffer: requestBuffer,
        },
      },
      {
        binding: 2,
        resource: {
          buffer: resources.get(frame.store) as GPUBuffer,
        },
      },
    ],
  });

  const pass = command.beginComputePass({
    label: "Surface/SignalStore publish",
  });

  pass.setPipeline(publishPipeline);
  pass.setBindGroup(0, group);
  pass.dispatchWorkgroups(workgroupCount);
  pass.end();
});

node.read(requests);
node.write(store);
node.make_side_effect();
```

Do not split these statements into generic `PassBuilder` or `ResourceManager`
wrappers solely to make `addToGraph()` shorter. Split when the code becomes a
separate owner with its own lifecycle or a genuinely reusable shader/pipeline
boundary.

## Names and comments

Prefer `geometryRecord`, `fieldIdentity`, `signalStoreBuffer`,
`workgroupCount`, and `retiredBuffer` over `r`, `tmp`, or `b`. Comments should
explain GPU contracts, units, capacity, ordering, or why a fallback exists.
Do not comment obvious increments or loop syntax.

## Formatter boundary

Use repository Prettier or ESLint if configured, but keep GPU-specific decisions
in source. Do not add a formatter dependency or reformat unrelated files as a
side effect of a renderer change.
