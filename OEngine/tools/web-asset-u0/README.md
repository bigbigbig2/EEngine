# Historical U0 Measurements

`results.json` and the original `.local/web-asset-u0/` logs retain the measured
inputs, hashes, results and failures. They are not production qualification.
The copied baseRevision has a typo; the actual P commit is
`5f3f41533e25901cbbd1da9c3ae751c64bc0a9c9`.

E2 deletes the retired texture encoder, WASM/build/browser drivers and report
regenerator. Their original source is available through Git (before E2), not
as a second runnable texture pipeline. Do not regenerate the immutable snapshot
using new sources or rewrite old failures as passing results.

`GeometryProbe.cpp`, `geometry.mjs` and `common.mjs` remain independent historical
geometry references; they use the original local probe binary, not a production
owner or a supported reconstruction of the old texture experiment.

Current authority:
`docs/next-execution/eengine-extreme-web-asset-compression-execution-2026-10.md`,
section 10. The replacement image pipeline is under `tools/extreme-web-asset/`.
Spark JS MIT does not grant shader redistribution rights; local evaluation
sources remain separately scoped.
