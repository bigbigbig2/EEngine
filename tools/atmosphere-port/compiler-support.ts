// Offline compiler boundary only. Takram helper implementations are copied at the
// pinned revision, not imported from an npm package. See upstream/packages/core/LICENSE.
export { FnVar } from './upstream/packages/core/src/webgpu/FnVar';
export { FnLayout } from './upstream/packages/core/src/webgpu/FnLayout';
export { reinterpretType } from './upstream/packages/core/src/types';
// Local unit conversion, not a scattering algorithm replacement.
export const radians = (degrees: number): number => degrees * Math.PI / 180;

import { Data3DTexture, NearestFilter, RedFormat, RepeatWrapping } from 'three';
import { Fn, globalId, texture3D, uniform, vec3 } from 'three/tsl';

// STBNTextureNode.ts: same 128x128x64 scalar data, nearest/repeat and frame%64.
// The EEngine host binds the copied file; offline compilation performs no URL load.
// Fragment pixel centres become compute invocation centres, preserving texel choice.
const noise = new Data3DTexture(new Uint8Array(1), 128, 128, 64);
noise.name = 'Atmosphere/STBN';
noise.format = RedFormat;
noise.minFilter = noise.magFilter = NearestFilter;
noise.wrapS = noise.wrapT = noise.wrapR = RepeatWrapping;
export const stbnFrame = uniform(0, 'uint').setName('atmosphereFrame');
export const stbn = Fn(() => texture3D(noise)
  .sample(vec3(globalId.xy.toFloat().add(0.5), stbnFrame.mod(64)).div(vec3(128, 128, 64)))
  .r.toConst('stbn')).once()();
