import test from 'node:test';
import assert from 'node:assert/strict';
import { AppearanceGraphBuilder, snapshotAppearanceTexture } from '../../.test-dist/material/AppearanceGraph.js';
import { compileAppearanceGraph } from '../../.test-dist/material/AppearanceGraphCompiler.js';
import { ShadeTexture } from '../../.test-dist/texture/ShadeTexture.js';
import { AppearanceProgramRegistry } from '../../.test-dist/gpu/AppearanceProgramRegistry.js';
import { publishSurfaceFieldIdentities } from '../../.test-dist/gpu/GpuSurfaceFieldIdentityAbi.js';

const texture = new ShadeTexture();
const registry = new AppearanceProgramRegistry({ lost: new Promise(() => {}) });
const publish = program => publishSurfaceFieldIdentities(registry, program, 101, () => [7, 11, 13, 17], () => undefined);
function graph(roughness = .5, reorder = false, gain = 1) {
  const g = new AppearanceGraphBuilder();
  if (reorder) g.output('emissive', g.parameter('E', [2, 3, 4]));
  const uv = g.input('uv0', 2, 'surface', undefined, 'uv0');
  const tex = g.texture(snapshotAppearanceTexture(texture, 'linear-rgb'), uv);
  g.output('baseColor', g.operation('multiply', g.swizzle(tex, [0, 1, 2]), g.parameter('gain', gain)));
  g.output('roughness', g.parameter('r', roughness));
  if (!reorder) g.output('emissive', g.parameter('E', [2, 3, 4]));
  return compileAppearanceGraph(g.build());
}
test('publication identities preserve unchanged closures across unrelated output edits/order', () => {
  const a = publish(graph()).identities;
  const b = publish(graph(.75, true)).identities;
  assert.equal(a[0], b[0]);
  assert.notEqual(a[3 * 8], b[3 * 8]);
  assert.equal(a[5 * 8], b[5 * 8]);
  assert.notEqual(a[0], publish(graph(.5, false, 2)).identities[0]);
  assert.equal(a[3] & 3, 1, 'UV-local field excludes camera revision');
  assert.deepEqual([...publish(graph()).textureSlots], [11]);
});
test('actual view semantics and f32 signed zero remain distinct publication proofs', () => {
  const build = kind => {
    const g = new AppearanceGraphBuilder();g.output('baseColor', g.input(kind, 3, 'view'));
    return publish(compileAppearanceGraph(g.build())).identities;
  };
  assert.equal(build('worldNormal')[3] & 2, 0);
  assert.equal(build('viewNormal')[3] & 2, 2);
  assert.equal(build('viewDirection')[3] & 2, 2);
  const signed = value => { const g = new AppearanceGraphBuilder();g.output('emissive', g.parameter('E', [value, 0, 0]));return publish(compileAppearanceGraph(g.build())).identities[5 * 8]; };
  assert.notEqual(signed(0), signed(-0));
});
