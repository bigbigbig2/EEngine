import test from 'node:test';
import assert from 'node:assert/strict';
import {AppearanceGraphBuilder,snapshotAppearanceTexture} from '../../.test-dist/material/AppearanceGraph.js';
import {compileAppearanceGraph} from '../../.test-dist/material/AppearanceGraphCompiler.js';
import {lowerAppearanceWgsl} from '../../.test-dist/shaders/appearance_program.js';
import {lowerAppearanceFieldBounds} from '../../.test-dist/shaders/appearance_field_bounds.js';
import {ShadeTexture} from '../../.test-dist/texture/ShadeTexture.js';

test('one ORM RGBA equivalence class covers three channel closures with only live UV components',()=>{
  const g=new AppearanceGraphBuilder(),texture=new ShadeTexture();
  const uv=g.input('uv0',2,'surface',undefined,'uv0'),color=g.input('vertexColor',3,'geometry');
  const binding=snapshotAppearanceTexture(texture,'linear-rgb');
  for(const [field,channel]of [['occlusion',0],['roughness',1],['metallic',2]])g.output(field,g.swizzle(g.texture(binding,uv),[channel]));
  g.output('baseColor',color);
  const compiled=compileAppearanceGraph(g.build()),profiles=lowerAppearanceFieldBounds(compiled,lowerAppearanceWgsl(compiled)).dependencyProfiles;
  assert.equal(compiled.samples.length,1);
  for(const field of ['occlusion','roughness','metallic']){
    assert.deepEqual(profiles[field].samples,[0]);
    assert.deepEqual(profiles[field].inputs.map(input=>[compiled.inputs[input.index].name,input.channel]).sort(),[['uv0',0],['uv0',1]]);
    assert.ok(profiles[field].supported);
  }
  assert.deepEqual(profiles.baseColor.samples,[]);
  assert.ok(profiles.baseColor.inputs.every(input=>compiled.inputs[input.index].name==='vertexColor'));
});
test('different UV DAG, transform, sampler or decode keeps a separate sample class; dynamic risk is local',()=>{
  const g=new AppearanceGraphBuilder(),texture=new ShadeTexture(),binding=snapshotAppearanceTexture(texture,'linear-rgb');
  const uv=g.input('uv0',2,'surface',undefined,'uv0');
  const shifted=g.operation('add',uv,g.constant([.1,0]));
  const dynamic=g.input('dynamic',1,'dynamic');
  const bindings=[binding,{...binding,offset:[.1,0]},{...binding,sampler:binding.sampler.map((v,i)=>i===4?v+1:v)}, {...binding,decode:'srgb-rgb'}];
  bindings.forEach((sample,index)=>g.output(`field${index}`,g.swizzle(g.texture(sample,uv),[0])));
  g.output('shifted',g.swizzle(g.texture(binding,shifted),[0]));g.output('emissive',dynamic);
  const compiled=compileAppearanceGraph(g.build()),profiles=lowerAppearanceFieldBounds(compiled,lowerAppearanceWgsl(compiled)).dependencyProfiles;
  assert.equal(compiled.samples.length,5);
  assert.equal(new Set(Object.values(profiles).flatMap(profile=>profile.samples)).size,5);
  assert.equal(profiles.emissive.supported,false);
  assert.ok(profiles.field0.supported);
});
