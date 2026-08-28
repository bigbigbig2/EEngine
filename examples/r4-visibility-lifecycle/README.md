# R4-A-05 Visibility Lifecycle

This page runs the production Packed Visibility path and records:

- feature-off frames with no debug resolve, counter reducer or readback;
- sampled overflow counters;
- resize, camera-cut and view recreation history behavior;
- immediate Packed Scene release/re-upload after a submitted frame;
- exact adapter/key capacity validation and explicit overflow rejection;
- intentional device destruction, old Renderer stop, and fresh Renderer/device rebuild.

The glTF fixture is shared with `../r4-debug-resolve/alpha-mask.gltf`; GPU resources
are recreated from the retained device-independent cooked packages after device loss.
