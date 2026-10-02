import assert from 'node:assert/strict';
import test from 'node:test';
import { prepareGeometrySurfacePublication } from '../../.test-dist/gpu/GeometrySurfacePublication.js';
import { decodeSurfacePrimitive } from '../../.test-dist/gpu/SurfacePrimitiveAbi.js';
import { GPU_MESHLET_RECORD_SCHEMA, packGpuMeshletRecords } from '../../.test-dist/gpu/GpuGeometryAbi.js';

function fixture(seam = false) {
  const positions = seam ? [[0,0],[1,0],[0,1],[1,0],[1,1],[0,1]] : [[0,0],[1,0],[0,1],[1,1]];
  const values = new Float32Array(positions.length * 24);
  for (let i=0; i<positions.length; i++) {
    const at=i*24, p=positions[i];
    values.set([0,0,1],at); values.set([1,0,0,1],at+4);
    values.set([p[0]+(seam && i>=3 ? 2:0),p[1]],at+8);
    values.set(p,at+10); values.set([1,1,1,1],at+12); values.set([p[0],p[1],0,1],at+20);
  }
  const indices = seam ? [0,1,2,3,4,5] : [0,1,2,1,3,2];
  const coarse = seam ? [0,3,4] : [0,1,3];
  return { attributes:new Uint8Array(values.buffer), asset:{ indices:new Uint32Array(indices),
    materialRanges:[{ firstTriangle:0, triangleCount:2, materialId:7 }],
    meshletVertexIndices:new Uint32Array([...indices,...coarse]),
    meshletTriangleIndices:new Uint8Array([0,1,2,0,1,2,0,1,2]),
    meshlets:[0,1,2].map(i=>({ vertexOffset:i*3, triangleOffset:i*3, triangleCount:1, materialId:7 })),
    surfacePrimitiveIds:new Uint32Array([0,1,2]),
    clusters:[{ meshletBegin:0, meshletCount:2, depth:1, geometricError:0 },
      { meshletBegin:2, meshletCount:1, depth:0, geometricError:0.125 }]
  }};
}
test('ordinary publication preserves source domains across meshlets and new coarse triangles',()=>{
  const {asset,attributes}=fixture();
  const bytes=prepareGeometrySurfacePublication(asset,attributes);
  assert.equal(bytes.byteLength,192);
  const records=[0,64,128].map(at=>decodeSurfacePrimitive(bytes,at));
  for (const key of ['domain','uv0Domain','uv1Domain','normalDomain','tangentDomain','colorDomain']) {
    assert.equal(records[0][key],records[1][key]); assert.equal(records[0][key],records[2][key]);
  }
  assert.equal(records[2].positionError,0.125);
  assert.equal(records[2].risk,0);
});
test('coarse UV0 correspondence failure is local to UV0 and does not erase geometry lineage',()=>{
  const {asset,attributes}=fixture(true);
  const bytes=prepareGeometrySurfacePublication(asset,attributes);
  const a=decodeSurfacePrimitive(bytes,0), b=decodeSurfacePrimitive(bytes,64), coarse=decodeSurfacePrimitive(bytes,128);
  assert.equal(a.domain,b.domain); assert.equal(coarse.domain,a.domain);
  assert.notEqual(a.uv0Domain,b.uv0Domain);
  assert.notEqual(coarse.uv0Domain,a.uv0Domain); assert.notEqual(coarse.uv0Domain,b.uv0Domain);
  assert.equal(coarse.fieldRisk>>>16,2);
  assert.equal(coarse.uv1Domain,a.uv1Domain);
  assert.ok(coarse.risk&4);
});
test('GPU meshlet ABI publishes actual continuity offset and version independently of primitive identity',()=>{
  const packed=packGpuMeshletRecords([{ vertexOffset:0,vertexCount:3,triangleByteOffset:0,triangleCount:1,
    materialRangeIndex:0,materialId:7,flags:0,surfacePrimitiveWordOffset:100,surfaceMetadataWordOffset:128,
    surfaceMetadataVersion:2,boundsMin:[0,0,0],boundsMax:[1,1,0],boundsSphere:[0,0,0,1],
    coneApex:[0,0,0,0],coneAxisCutoff:[0,0,1,0] }]);
  assert.equal(packed.byteLength,128);
  const view=new DataView(packed.buffer);
  assert.equal(view.getUint32(GPU_MESHLET_RECORD_SCHEMA.offsets.surface_primitive_word_offset,true),100);
  assert.equal(view.getUint32(GPU_MESHLET_RECORD_SCHEMA.offsets.surface_metadata_word_offset,true),128);
  assert.equal(view.getUint32(GPU_MESHLET_RECORD_SCHEMA.offsets.surface_metadata_version,true),2);
});
