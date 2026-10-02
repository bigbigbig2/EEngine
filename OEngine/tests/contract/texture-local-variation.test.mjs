import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTextureLocalVariation, queryTextureLocalVariation, textureVariationNormalCone,
 encodeTextureLocalVariation,decodeTextureLocalVariation } from '../../src/texture/TextureLocalVariation.ts';
const request={minU:0.125,maxU:0.125,minV:0.5,maxV:0.5,lod:0,filter:'nearest',mipFilter:'nearest',wrapU:'clamp-to-edge',wrapV:'clamp-to-edge'};
function mip(width,height,fn){const rgba=new Float32Array(width*height*4);for(let y=0;y<height;y++)for(let x=0;x<width;x++)rgba.set(fn(x,y),(y*width+x)*4);return {width,height,rgba};}
test('local query preserves a smooth region despite unrelated high-contrast texture region',()=>{
 const tree=buildTextureLocalVariation([mip(16,8,x=>[x<8?0.25:1,0.5,1,1])],2);
 const bounds=queryTextureLocalVariation(tree,request);
 assert.equal(bounds.known,true);assert.equal(bounds.low[0],0.25);assert.equal(bounds.high[0],0.25);
 assert.ok(bounds.nodesRead<=4);
});
test('bilinear halo observes both border texels and repeat wrapping',()=>{
 const tree=buildTextureLocalVariation([mip(8,4,x=>[x===7?4:0,0,0,1])],1);
 const bounds=queryTextureLocalVariation(tree,{...request,minU:0,maxU:0,filter:'linear',wrapU:'repeat'});
 assert.equal(bounds.low[0],0);assert.equal(bounds.high[0],4);
});
test('negative repeat and mirror coordinates map to actual source texels',()=>{
 const tree=buildTextureLocalVariation([mip(8,4,x=>[x,0,0,1])],1);
 const repeat=queryTextureLocalVariation(tree,{...request,minU:-0.0625,maxU:-0.0625,wrapU:'repeat'});
 const mirror=queryTextureLocalVariation(tree,{...request,minU:-0.0625,maxU:-0.0625,wrapU:'mirror-repeat'});
 assert.equal(repeat.low[0],7);assert.equal(repeat.high[0],7);
 assert.equal(mirror.low[0],0);assert.equal(mirror.high[0],0);
});
test('trilinear footprint unions actual mip values and rejects absent resident mip',()=>{
 const tree=buildTextureLocalVariation([mip(4,4,()=>[0,0,0,1]),mip(2,2,()=>[2,0,0,1])],1);
 const bounds=queryTextureLocalVariation(tree,{...request,lod:0.5,mipFilter:'linear'});
 assert.deepEqual(bounds.mipsRead,[0,1]);assert.equal(bounds.low[0],0);assert.equal(bounds.high[0],2);
 assert.equal(queryTextureLocalVariation(tree,{...request,lod:0.5,mipFilter:'linear',residentMipRange:[1,1]}).known,false);
});
test('NPOT hierarchy and oversized footprint remain bounded and conservative',()=>{
 const tree=buildTextureLocalVariation([mip(13,7,(x,y)=>[x+y,0,0,1])],2);
 const bounds=queryTextureLocalVariation(tree,{...request,minU:-10,maxU:10,minV:-20,maxV:20,wrapU:'repeat',wrapV:'mirror-repeat'});
 assert.equal(bounds.low[0],0);assert.equal(bounds.high[0],18);assert.ok(bounds.nodesRead<=4);
});
test('flat decoded normal gives a useful cone; unknown/origin-containing boxes cannot certify it',()=>{
 const tree=buildTextureLocalVariation([mip(4,4,()=>[0.5,0.5,1,1])],2);
 const bounds=queryTextureLocalVariation(tree,request);
 for(const decode of ['rgb','xy-positive-z']){const cone=textureVariationNormalCone(bounds,decode);assert.equal(cone.known,true);assert.ok(cone.cosAngle>0.99999);assert.deepEqual(cone.axis,[0,0,1]);}
 assert.equal(textureVariationNormalCone({known:true,low:[0,0,0,0],high:[1,1,1,1]},'rgb').known,false);
});
test('budget, invalid source and impossible coordinates never publish partial or false-valid bounds',()=>{
 const input=mip(4,4,()=>[1,1,1,1]);
 assert.throws(()=>buildTextureLocalVariation([input],1,32),RangeError);
 input.rgba[0]=NaN;assert.throws(()=>buildTextureLocalVariation([input],1),RangeError);
 const tree=buildTextureLocalVariation([mip(1,1,()=>[1,1,1,1])],1);
 assert.equal(queryTextureLocalVariation(tree,{...request,minU:1e100,maxU:1e100}).known,false);
});
test('offline codec preserves bounded footprints and rejects corrupted level/data offsets',()=>{
 const tree=buildTextureLocalVariation([mip(8,8,(x,y)=>[x,y,1,1]),mip(4,4,(x,y)=>[x,y,0,1])],2);
 const bytes=encodeTextureLocalVariation(tree), decoded=decodeTextureLocalVariation(bytes);
 assert.deepEqual(queryTextureLocalVariation(decoded,{...request,lod:0.25,mipFilter:'linear'}),queryTextureLocalVariation(tree,{...request,lod:0.25,mipFilter:'linear'}));
 const corrupted=bytes.slice();new DataView(corrupted.buffer).setUint32((8+3)*4,0xffffffff,true);
 assert.throws(()=>decodeTextureLocalVariation(corrupted),RangeError);
 assert.throws(()=>decodeTextureLocalVariation(bytes.subarray(0,bytes.length-4)),RangeError);
});
