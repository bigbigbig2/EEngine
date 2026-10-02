import assert from 'node:assert/strict';
import test from 'node:test';
import { writeEncodedTextureAssetPackageV2, openTextureAssetPackageV2, selectTextureAssetVariantV2 } from '../../.test-dist/assets/TextureAssetPackage.js';
import { queryTextureLocalVariation } from '../../.test-dist/texture/TextureLocalVariation.js';
test('RGBA8 cooker publishes a typed binary local hierarchy and keeps texture-resident bytes separate',async()=>{
 const rgba8=new Uint8Array(8*8*4).fill(255),mips=[];
 for(let level=0;level<4;level++){
  const width=8>>level,payload=new Uint8Array(width*width*4);
  for(let i=0;i<width*width;i++)payload.set([level*32,128,255,255],i*4);
  mips.push({level,logicalWidth:width,logicalHeight:width,physicalWidth:width,physicalHeight:width,payload});
 }
 const bytes=await writeEncodedTextureAssetPackageV2({width:8,height:8,rgba8,semantic:'orm-linear',sourceUri:'test://variation'},[
  {profile:'portable-rgba8',semantic:'orm-linear',format:'rgba8unorm',blockWidth:1,blockHeight:1,bytesPerBlock:4,
   codecId:'rgba8-fixture',codecRevision:'1',codecBinaryHash:'0'.repeat(64),mips}]);
 const asset=await openTextureAssetPackageV2(bytes),variant=selectTextureAssetVariantV2(asset,new Set());
 assert.ok(variant.localVariationChunkId);assert.ok(variant.localVariation);
 const bounds=queryTextureLocalVariation(variant.localVariation,{minU:0.5,maxU:0.5,minV:0.5,maxV:0.5,lod:1,
  filter:'linear',mipFilter:'nearest',wrapU:'repeat',wrapV:'repeat'});
 assert.equal(bounds.known,true);assert.equal(bounds.low[0],Math.fround(32/255));assert.equal(bounds.high[0],Math.fround(32/255));
 assert.equal(asset.evidence.expectedResidentBytesByVariant[variant.id],340,'shared variation pool is accounted by its GPU owner');
 const chunk=asset.runtime.manifest.chunks.find(c=>c.id===variant.localVariationChunkId);
 assert.equal(chunk.expectedResidentBytes,0);assert.ok(chunk.decodedBytes>0);
});
