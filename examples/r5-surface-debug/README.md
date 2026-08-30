# R5 FX-01 Surface Debug + Background

This production fixture uploads one 2×3 Packed material board through the
public cooker and `Renderer.render()` path. It exposes the required Surface
debug groups, retains more than 25% visible background, records feature-off
FrameGraph pruning including exact zero debug resources/readbacks, and runs
validation-only GPU readbacks with the production debug WGSL against valid and
deliberately non-zero invalid payload bytes. Emissive is additionally read back
from an `rgba16float` target so the artifact proves linear HDR values above 1.

The browser runner uses `window.__OENGINE_FX_01__` to select views and direct
light state, and waits for `window.__OENGINE_FX_01_RESULT__.completed` before
capturing JSON, graph evidence, diagnostics, per-view screenshot metrics, and
screenshots. The material/motion group is named `MaterialAndMotion`; the
history-validity view is not aliased as raw `SurfaceFlags`.

The Gate binds the page's embedded commit/dirty metadata and complete dirty
content hash to the runner's Git worktree, records the adapter from the
Renderer device, and evaluates the diagnostics returned after every capture.
It hides the overlapping status sidebar while capturing the pure 960×720 GPU
canvas. It compares the emissive Surface
attachment across the light toggle and saves final-lighting on/off screenshots
with a lit control ROI. The current legacy Direct Lighting response on the
final unlit ROI is retained as an automatic FX-02 finding; FX-01 does not edit
the Lighting oracle before its documented source-of-truth migration.

Run the production browser Gate after `npm run build` and while the production
preview server is available at `http://127.0.0.1:5174`:

```powershell
npm run gate:r5-fx01
```

The runner decodes the saved PNG files rather than reading the presented
WebGPU canvas back through a 2D canvas API. It writes the complete artifact to
`temp/r5/fx-01/<commit>/` and rejects dirty worktrees by default; exploratory
dirty runs use a content-hash suffix and cannot overwrite clean evidence. Browser,
navigation, screenshot, PNG decode, and device failures still write the
standard JSON evidence collected before the failure.
