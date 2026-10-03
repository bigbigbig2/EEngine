# EEngine style examples

These examples were derived from real patterns in the current EEngine sources:
`GpuSurfaceSignalStore.ts`, `GpuSurfaceFieldStore.ts`,
`SurfaceCellClassifierPass.ts`, `SurfaceLightingWorkPass.ts`,
`SurfaceReconstructionPass.ts`, `surface_cell_classify.ts`, and
`surface_cell_production_facts.ts`. They are guidance for touched code; they do
not authorize formatting or changing those production files by themselves.

## Lifecycle owner

Dense current pattern from the SignalStore owner:

```ts
destroy():void{if(this.destroyed)return;this.destroyed=true;for(const b of this.buffers)b.destroy();if(this.handle)this.accounting!.destroyed(this.handle);}
```

Readable form:

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

The readable form exposes idempotence, the owned buffers, and accounting
retirement. It does not add a lifecycle manager.

## Pipeline and pass encoding

Dense current pattern from `SurfaceLightingWorkPass`:

```ts
this.planPipeline=device.createComputePipeline({label:"Surface/lighting classify",layout:"auto",compute:{module:device.createShaderModule({code:LIGHTING_PLAN_WGSL}),entryPoint:"plan"}});
```

Readable form:

```ts
const planModule = device.createShaderModule({
  label: "Surface/lighting classify",
  code: LIGHTING_PLAN_WGSL,
});

this.planPipeline = device.createComputePipeline({
  label: "Surface/lighting classify",
  layout: "auto",
  compute: {
    module: planModule,
    entryPoint: "plan",
  },
});
```

For pass encoding, keep the dispatch as a visible sequence:

```ts
const pass = command.beginComputePass({
  label: "Surface/lighting packets",
});

pass.setPipeline(this.pipeline);
pass.setBindGroup(0, group0);
pass.setBindGroup(1, group1);
pass.dispatchWorkgroupsIndirect(dispatchBuffer, 0);
pass.end();
```

## FrameGraph declarations

Dense current patterns combine `create`, `read`, and `write` declarations:

```ts
dirtyCounts=node.create("Surface/dirty lighting count",{kind:"transient_buffer",size:32,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC|GPUBufferUsage.COPY_DST});
dirtyQueue=node.write(dirtyQueue); node.read(input.geometryKeys); node.read(signalStoreBuffer);
```

Readable form:

```ts
dirtyCounts = node.create("Surface/dirty lighting count", {
  kind: "transient_buffer",
  size: 32,
  usage: GPUBufferUsage.STORAGE |
    GPUBufferUsage.COPY_SRC |
    GPUBufferUsage.COPY_DST,
});

dirtyQueue = node.write(dirtyQueue);
node.read(input.geometryKeys);
node.read(signalStoreBuffer);
```

Keep these declarations beside the pass that consumes them so dependency and
lifetime review remains local.

## WGSL early return and loop

Dense current pattern from the request-pack generator:

```wgsl
let record=id.x;if(record>=settings.request_count){return;}let source=record*settings.cache_stride;let target=record*settings.request_stride;
for(var word=0u;word<12u;word++){requests[target+word]=cache[source+word];}
```

Readable form:

```wgsl
let record = id.x;

if (record >= settings.request_count) {
  return;
}

let source = record * settings.cache_stride;
let target = record * settings.request_stride;

for (var word = 0u; word < 12u; word++) {
  requests[target + word] = cache[source + word];
}
```

The block shape makes the bounds check and stride arithmetic easy to audit.

## WGSL generator composition

`surface_cell_classify.ts` and `surface_cell_production_facts.ts` legitimately
generate long shader stages. Keep the generator readable by naming the fact
library, stage ranges, bindings, and entry point separately. Do not turn a
large stage into dozens of tiny helpers, and do not build it with a deeply
nested interpolation/map expression. The generated shader may be large; the
TypeScript that explains how it is assembled must remain easy to inspect.

## What not to infer

These examples do not mean that every existing dense line must be reformatted
now. Apply the style to the current change, and preserve ABI literals and local
GPU ownership where expanding an abstraction would make the producer/consumer
relationship harder to follow.
