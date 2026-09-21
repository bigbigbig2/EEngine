# Browser Harness

The harness owns browser and WebGPU lifecycle concerns shared by every validation case:

- versioned identity and freshness (`protocol.ts`)
- GPU error scopes, device-loss collection, capability fingerprints, and bounded readback (`webgpu.ts`)
- production frame observation (`production-gpu-observer.ts`)

Case code owns only the scenario setup, workload actions, and assertions. Each case keeps `case.yaml`, `main.ts`, and `index.html` together under `validation/cases/<id>/`; lab cases live under `validation/labs/<id>/`. The manifest declares `kind` (`unit`, `contract`, `oracle`, `guard`, `gpu`, or `perf`), `level` (`L0` through `L4`), and harness profile (`protocol`, `gpu`, `production`, or `observer`).

The harness implementation and facade live together under `validation/harness/`. New cases must import from `validation/harness/browser.ts`; they should not import lifecycle internals directly.
