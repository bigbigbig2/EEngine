import test from 'node:test';
import assert from 'node:assert/strict';
import {AppearanceGraphBuilder,snapshotAppearanceTexture} from '../../.test-dist/material/AppearanceGraph.js';
import {compileAppearanceGraph} from '../../.test-dist/material/AppearanceGraphCompiler.js';
import {appearanceExecutionProfiles,appearanceExecutionClosure,FIELD_CACHE_CLASS,SURFACE_SIGNAL_FIELD_MASKS} from '../../.test-dist/material/AppearanceExecutionProfile.js';
import {packSurfaceExecutionProfiles,SURFACE_EXECUTION_WORDS,SURFACE_FIELD_EXECUTION_WORDS} from '../../.test-dist/gpu/GpuSurfaceExecutionProfileAbi.js';
import {AppearanceProgramRegistry} from '../../.test-dist/gpu/AppearanceProgramRegistry.js';
import {ShadeTexture} from '../../.test-dist/texture/ShadeTexture.js';
import {APPEARANCE_FIELD_NAMES} from '../../.test-dist/gpu/GpuAppearanceFieldAbi.js';
import {surfaceCoverageLayout} from '../../.test-dist/gpu/GpuSurfaceCoverageAbi.js';
import {updateAppearanceFieldVersions} from '../../.test-dist/material/AppearanceFieldIdentity.js';

const registry=new AppearanceProgramRegistry({lost:new Promise(()=>{})});
const profile=program=>appearanceExecutionProfiles(program,key=>registry.internFieldPublication(key));
const compile=builder=>compileAppearanceGraph(builder.build());
const texture=new ShadeTexture();

test('ORM shares exact query/dependency groups while cost accounts for the complete original coordinate DAG',()=>{
  const g=new AppearanceGraphBuilder(),uv=g.input('uv0',2,'surface',undefined,'uv0');
  const shifted=g.operation('add',uv,g.constant([.1,.2]));
  const sample=g.texture(snapshotAppearanceTexture(texture,'linear-rgb'),shifted);
  for(const [name,channel] of [['occlusion',0],['roughness',1],['metallic',2]])g.output(name,g.swizzle(sample,[channel]));
  const program=compile(g),p=profile(program);
  const fields=[p.fields[2],p.fields[3],p.fields[4]];
  assert.equal(new Set(fields.map(field=>p.groups[field.group].token)).size,1);
  for(const field of fields){
    assert.equal(field.inputMask,1<<1);assert.equal(field.domain.seamMask,1);assert.equal(field.domain.uvMask,1);
    assert.equal(field.cacheClass,FIELD_CACHE_CLASS.stable);assert.equal(field.proof.queries,1);
    assert.equal(field.valueSamples,1,'Ordinary UV arithmetic does not duplicate the final sample');
    assert.equal(field.proof.nodes,appearanceExecutionClosure(program,program.outputs[APPEARANCE_FIELD_NAMES[p.fields.indexOf(field)]]).length+field.proof.coordinateNodes*2+field.proof.queries);
    assert.ok(field.proof.coordinateNodes>=6);assert.equal(field.proof.visitBound,32);
  }
  assert.equal(p.groups[fields[0].group].fields,(1<<2)|(1<<3)|(1<<4));
});

test('texture-driven coordinates count C/X/Y queries and reject unsupported derivative proof locally',()=>{
  const g=new AppearanceGraphBuilder(),uv=g.input('uv0',2,'surface',undefined,'uv0');
  const coordinates=g.swizzle(g.texture(snapshotAppearanceTexture(texture,'linear-rgb'),uv),[0,1]);
  const value=g.texture(snapshotAppearanceTexture(new ShadeTexture(),'linear-rgb'),coordinates);
  g.output('roughness',g.swizzle(value,[1]));g.output('normalTS',g.swizzle(g.texture(snapshotAppearanceTexture(texture,'linear-rgb'),uv),[0,1,2]));
  const p=profile(compile(g));
  assert.equal(p.fields[3].proof.queries,2);assert.equal(p.fields[3].valueSamples,5);
  assert.equal(p.fields[3].proof.supported,false);assert.equal(p.fields[3].cacheClass,FIELD_CACHE_CLASS.stable,'Unsupported domain proof retains complete UV ExactPoint caching');
  assert.equal(p.fields[6].proof.supported,true);assert.equal(p.fields[6].cacheClass,FIELD_CACHE_CLASS.stable);
});

test('sample transforms, sources and UV lineage never alias an interned dependency group',()=>{
  const make=(source,offset,uvName)=>{
    const g=new AppearanceGraphBuilder(),uv=g.input(uvName,2,'surface',undefined,uvName);
    g.output('roughness',g.swizzle(g.texture({...snapshotAppearanceTexture(source,'linear-rgb'),offset},uv),[1]));
    return profile(compile(g));
  };
  const a=make(texture,[0,0],'uv0'),same=make(texture,[0,0],'uv0');
  assert.equal(a.fields[3].token,same.fields[3].token);
  for(const p of [make(texture,[.1,0],'uv0'),make(new ShadeTexture(),[0,0],'uv0'),make(texture,[0,0],'uv2')]){
    assert.notEqual(a.groups[a.fields[3].group].token,p.groups[p.fields[3].group].token);
  }
  const uv2=make(texture,[0,0],'uv2').fields[3];
  assert.equal(uv2.domain.seamMask,64);assert.equal(uv2.domain.primitiveLocal,true);
});

test('default/constant, geometry, view and nonlocal routes remain independent',()=>{
  const g=new AppearanceGraphBuilder();
  g.output('baseColor',g.constant([.2,.3,.4]));
  g.output('roughness',g.input('dynamic',1,'dynamic'));
  g.output('emissive',g.input('viewDirection',3,'view'));
  g.output('normalTS',g.input('normal',3,'geometry'));
  const p=profile(compile(g));
  assert.equal(p.fields[0].cacheClass,FIELD_CACHE_CLASS.publication);
  assert.equal(p.fields[1].present,false);assert.equal(p.fields[1].publication,true);
  assert.equal(p.fields[3].cacheClass,FIELD_CACHE_CLASS.transient);assert.equal(p.fields[3].proof.supported,false);
  assert.equal(p.fields[5].cacheClass,FIELD_CACHE_CLASS.transient);assert.equal(p.fields[6].cacheClass,FIELD_CACHE_CLASS.transient,'Cheap geometry input skips persistent cache work');
  assert.equal(p.fields[6].domain.seamMask,4);
  assert.ok(p.inputMask&(1<<8));assert.ok(p.inputMask&(1<<0));
});

test('profile identity and numeric versions survive unrelated output edits, but parameter changes invalidate their own field',()=>{
  const make=(factor,other)=>{
    const g=new AppearanceGraphBuilder();g.output('roughness',g.parameter('roughness',[factor]));
    g.output('baseColor',g.constant([other,0,0]));return compile(g);
  };
  const a=make(.5,.1),b=make(.5,.2),c=make(.75,.2);
  assert.equal(profile(a).fields[3].token,profile(b).fields[3].token);
  assert.notEqual(profile(b).fields[3].token,profile(c).fields[3].token);
  const old=updateAppearanceFieldVersions(a),next=updateAppearanceFieldVersions(b,old);
  assert.equal(next.get('roughness').changed,false);assert.equal(next.get('baseColor').changed,true);
});

test('all 15 fields and 6 signals pack actual masks, exact tokens and the current colored Ddirect contract',()=>{
  const g=new AppearanceGraphBuilder();
  for(const name of APPEARANCE_FIELD_NAMES)g.output(name,g.constant([1]));
  const p=profile(compile(g)),words=packSurfaceExecutionProfiles([p,p]);
  assert.equal(words.length,2*SURFACE_EXECUTION_WORDS);assert.equal(p.enabledMask,(1<<21)-1);
  assert.deepEqual(p.signals.map(signal=>signal.fields),SURFACE_SIGNAL_FIELD_MASKS);
  assert.ok(p.signals[0].fields&1);assert.equal(p.signals[0].semantic,'coloredResidual');
  assert.equal(p.signals[1].fields,(1<<6)|(1<<13));assert.equal(p.signals[1].semantic,'irradiance');
  assert.notEqual(p.fields[0].token,p.fields[5].token,'Output role and quality remain part of complete profile equality');
  assert.notEqual(p.fields[0].proof.token,p.fields[5].proof.token);
  for(let field=0;field<15;field++){
    const at=8+field*SURFACE_FIELD_EXECUTION_WORDS;
    assert.equal(words[at],p.fields[field].token);assert.equal(words[at+6],p.fields[field].domain.token);
    assert.equal(words[at+7],p.fields[field].proof.token);assert.equal(words[at+13],p.groups[p.fields[field].group].fields);
    assert.equal(words[at+16],p.fields[field].proof.visitBound);
    assert.equal(words[at+15]>>>8,p.fields[field].proof.qualityClass);
  }
  assert.deepEqual([...words.slice(0,SURFACE_EXECUTION_WORDS)],[...words.slice(SURFACE_EXECUTION_WORDS)]);
});

test('coverage reserves one fine descriptor and one mandatory active index for every padded tile',()=>{
  const layout=surfaceCoverageLayout(32400);
  assert.equal(layout.activeOffset,4+32400*8);assert.equal(layout.bytes,16+32400*36);
  assert.ok(layout.bytes<8*1024**2);assert.throws(()=>surfaceCoverageLayout(0),RangeError);
});
