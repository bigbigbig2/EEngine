# R5 FX-01 Surface Debug + Background

This production fixture uploads one 2×3 Packed material board through the
public cooker and `Renderer.render()` path. It exposes the required Surface
debug groups, retains more than 25% visible background, records feature-off
FrameGraph pruning, and runs validation-only GPU readbacks with the production
debug WGSL against valid and deliberately non-zero invalid payload bytes.

The browser runner uses `window.__OENGINE_FX_01__` to select views and direct
light state, and waits for `window.__OENGINE_FX_01_RESULT__.completed` before
capturing JSON, graph evidence, diagnostics, and screenshots.
