import test from 'node:test';
import assert from 'node:assert/strict';
import { referenceSurfaceCellPlans } from '../../.test-dist/render/surface/SurfaceCellReference.js';
import { SURFACE_CELL_PLAN_MODE as MODE, SURFACE_CELL_PLANE_COUNT as COUNT, SURFACE_CELL_SIGNAL as SIGNAL,
  SURFACE_CELL_RATE as RATE, SURFACE_CELL_TILE_PLAN_BYTES, SURFACE_CELL_TILE_MAP_BYTES,
  packSurfaceCellSixBit, surfaceCellSixBit } from '../../.test-dist/gpu/GpuSurfaceCellPlanAbi.js';
import { planSurfaceCellGeometryCapacity } from '../../.test-dist/gpu/GpuSurfaceCellGeometryAbi.js';

function lanes() {
 return Array.from({length:64},(_,i)=>({covered:true,winner:i+1,geometryIdentity:[1,2,9,0],
  planeIdentity:Array.from({length:COUNT},()=>[7,1]),worldPosition:[i%8,i>>3,0],plane:[0,0,1,0],
  worldUnitsPerPixel:1,normal:[0,0,1],normalCone:0,view:[0,0,1],roughnessLow:0.8,coatRoughnessLow:0.8,
  enabledMask:(1<<COUNT)-1,publicationMask:0,unknownMask:0,directSafe:true,
  bounds:Array.from({length:15},(_,field)=>({low:field===6||field===12?[0,0,1]:[0.25],high:field===6||field===12?[0,0,1]:[0.25]}))}));
}
test('different winners on continuous surface share 4x4 fields and 8x8 diffuse by default',()=>{
 const plans=referenceSurfaceCellPlans(lanes());
 assert.equal(plans[0].mode,MODE.grid);assert.equal(plans[0].rate,RATE.four);assert.equal(plans[0].groups.length,4);
 assert.equal(plans[0].crossWinnerGroups,4);
 assert.equal(plans[SIGNAL.environmentDiffuse].rate,RATE.eight);assert.equal(plans[SIGNAL.environmentDiffuse].groups.length,1);
 assert.equal(plans[SIGNAL.environmentSpecular].rate,RATE.four);
});
test('UV0 seam refines its fields without forcing unrelated fields or diffuse to full rate',()=>{
 const input=lanes();for(let i=0;i<64;i++)input[i].planeIdentity[0]=[7,i%8<3?1:2];
 const plans=referenceSurfaceCellPlans(input);
 assert.ok(plans[0].groups.length>4&&plans[0].groups.length<64);
 assert.equal(plans[1].rate,RATE.four);assert.equal(plans[SIGNAL.environmentDiffuse].rate,RATE.eight);
});
test('unknown normal texture leaves base and constant roughness independent; low roughness refines spec only',()=>{
 const input=lanes();for(const item of input){item.unknownMask=1<<6;item.roughnessLow=0.05;item.publicationMask=1<<3;}
 const plans=referenceSurfaceCellPlans(input);
 assert.equal(plans[6].mode,MODE.fine);assert.equal(plans[0].rate,RATE.four);
 assert.equal(plans[3].mode,MODE.publication);assert.equal(plans[3].slotCount,0);
 assert.equal(plans[SIGNAL.environmentSpecular].mode,MODE.fine);
});
test('incompatible instance/side, normal cone, geometry residual and unsafe direct are local rejections',()=>{
 const input=lanes();for(let i=0;i<64;i++){input[i].geometryIdentity=[i%2,2,9,i>>3&1];input[i].directSafe=false;}
 const plans=referenceSurfaceCellPlans(input);
 assert.equal(plans[0].mode,MODE.fine);
 assert.equal(plans[SIGNAL.directDiffuse].mode,MODE.fine);
 assert.equal(plans[SIGNAL.environmentDiffuse].mode,MODE.fine);
 const crease=lanes();for(let i=0;i<64;i++)if(i%8>=4){crease[i].worldPosition[2]=2;crease[i].normal=[0,1,0];}
 assert.ok(referenceSurfaceCellPlans(crease)[SIGNAL.environmentDiffuse].groups.length>1);
});
test('full-rate and regular plans carry no explicit 64-entry remap or per-pixel task list',()=>{
 const input=lanes();for(let i=0;i<64;i++)input[i].planeIdentity[0]=[i];
 const plan=referenceSurfaceCellPlans(input)[0];assert.equal(plan.mode,MODE.fine);assert.equal(plan.slotCount,64);
 assert.equal(plan.ownerMap.length,0);assert.equal(plan.representativeMap.length,0);
 assert.ok(SURFACE_CELL_TILE_PLAN_BYTES*4096<=4*1024**2);assert.ok(SURFACE_CELL_TILE_MAP_BYTES*4096<=8*1024**2);
});
test('masked group maps resolve covered representatives exactly, including packed word boundaries',()=>{
 const input=lanes();for(let i=0;i<64;i++)input[i].covered=(i%8!==0)&&(i!==19);input[2].planeIdentity[0]=[99];
 const plan=referenceSurfaceCellPlans(input)[0];assert.equal(plan.mode,MODE.masked);
 for(let i=0;i<64;i++)if(input[i].covered){const group=surfaceCellSixBit(plan.ownerMap,i),representative=surfaceCellSixBit(plan.representativeMap,group);
  assert.ok(input[representative].covered);assert.ok(plan.groups[group].includes(i));assert.ok(plan.groups[group].includes(representative));}
 const values=Uint8Array.from({length:64},(_,i)=>63-i),words=packSurfaceCellSixBit(values);
 for(let i=0;i<64;i++)assert.equal(surfaceCellSixBit(words,i),values[i]);
});
test('primitive setup, explicit references and complete frame addresses share the actual 32 MiB budget',()=>{
 const limits={maxBufferSize:1024**3,maxStorageBufferBindingSize:128*1024**2};
 const capacity=planSurfaceCellGeometryCapacity(262144,32*1024**2,limits);
 assert.equal(capacity.referenceCapacity,262144);assert.equal(capacity.setupBytes,capacity.setupCapacity*512);assert.ok(capacity.setupCapacity>0);
 assert.ok(capacity.reservedBytes<=32*1024**2);
 for(const targets of [64,384,16384,65536]){
  const binding=Math.min(2*1024**2,targets*128),budget=targets*128;
  const p=planSurfaceCellGeometryCapacity(targets,budget,{...limits,maxStorageBufferBindingSize:binding});
  assert.ok(p.reservedBytes<=budget);assert.ok(p.setupBytes<=binding);assert.ok(p.referenceBytes<=binding);
  assert.ok(p.setupCapacity>=1&&p.setupCapacity<=targets);assert.equal(p.referenceCapacity,targets);
 }
 assert.throws(()=>planSurfaceCellGeometryCapacity(64,4096,limits),RangeError);
});
