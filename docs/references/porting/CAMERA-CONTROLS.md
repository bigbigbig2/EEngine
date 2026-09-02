# Camera controls porting record

## Reference

- upstream project: three.js
- repository: https://github.com/mrdoob/three.js
- commit: `7cda7e710d884827fc73ff1a3aa63270846513d`
- source: `examples/jsm/controls/OrbitControls.js`
- license: MIT (`three.js/LICENSE`), copyright three.js authors; this notice is retained here and in the source header
- maturity: production addon used by the three.js examples suite
- decision: traceable local port (`adopt` of interaction semantics, not a runtime dependency)

## Scope and invariants

The port keeps the OrbitControls contract that matters for a scene viewer:

- spherical orbit around a target with polar/azimuth and distance limits;
- left-button/touch rotate, middle-button/wheel dolly, right-button/modifier pan;
- optional damping and auto-rotation;
- keyboard pan, pointer capture, context-menu suppression and touch pinch/pan;
- change/start/end notifications and explicit `dispose()` lifecycle.

The GPU renderer still receives only an OEngine `PerspectiveCamera`; no three.js object,
matrix, event dispatcher or allocation enters the render hot path.

## OEngine adaptation

- `THREE.Vector3`/`Spherical`/`Quaternion` are represented by `Vec3`, scalar spherical state
  and `Transform3D.rotation`.
- OEngine cameras look along +Z, so the spherical offset uses `atan2(x, z)` and calls
  `Transform3D.lookAt(target)` rather than copying three.js's -Z camera convention.
- `camera.update()` is called after a control update so frustum, view and temporal camera
  state stay coherent before `Renderer.render()`.
- Legacy `OrbitalCameraController` remains an export alias with `look`, `distanceLimits`,
  `movement_speed_scale`, and `pointer/keyboard.stop()` compatibility. New code should
  import `OrbitControls` and call `dispose()`.
- OEngine's `ChangeSignal` backs the typed `onChange/onStart/onEnd` signals while the
  three.js-style `addEventListener/removeEventListener` surface is also provided.
- Damping is enabled by default (`dampingFactor = 0.08`) for all OEngine examples that
  construct `OrbitControls`; callers can still disable it explicitly.

## Performance and fallback

Input handlers only accumulate scalar deltas. One camera transform and one camera update
occur per frame; there is no per-object scan or GPU allocation. The implementation uses
standard DOM Pointer Events and works without optional WebGPU features. When a DOM element
is unavailable, callers should not construct the controller; renderer headless/benchmark
paths continue to use a camera directly.

## Validation

- `cd OEngine && npm run typecheck`
- `cd examples && npm run typecheck:storybook`
- `cd examples && npm run build`
- `cd examples && npm run build:storybook`
- HTTP smoke: Vite served `rendering-lab/?mode=pipeline` and its module entry successfully.
- pending: interactive browser rotate/pan/zoom smoke after the local browser-control
  bootstrap is available.
