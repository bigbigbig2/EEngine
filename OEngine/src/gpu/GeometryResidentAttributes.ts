import { decodeGeometryPosition, decodeGeometryNormal, decodeGeometryTangent, decodeGeometryUv,
  decodeGeometryColor, type GeometryAssetPackage } from "../assets/GeometryAssetPackage.js";
import { GPU_FRAME_ATTRIBUTE_STRIDE } from "./GpuFrameGeometryAttributesAbi.js";

/** Residency fulfillment integration. Decode immutable source streams once;
 * frame transforms and miss consumers subsequently read the same f32 records.
 * The AssetStore owns upload, capacity, rollback and retirement of these bytes. */
export function prepareGeometryResidentAttributes(asset: GeometryAssetPackage): Uint8Array<ArrayBuffer> {
  const count=asset.directory.vertexCount;
  const values=new Float32Array(count*GPU_FRAME_ATTRIBUTE_STRIDE/4);
  for(let vertex=0;vertex<count;vertex++) {
    const at=vertex*GPU_FRAME_ATTRIBUTE_STRIDE/4;
    values.set(decodeGeometryNormal(asset,vertex) ?? [0,0,1],at);
    values.set(decodeGeometryTangent(asset,vertex) ?? [1,0,0,1],at+4);
    values.set(decodeGeometryUv(asset,"uv0",vertex) ?? [0,0],at+8);
    values.set(decodeGeometryUv(asset,"uv1",vertex) ?? [0,0],at+10);
    values.set([1,1,1,1],at+12);
    const color=decodeGeometryColor(asset,vertex); if(color) values.set(color,at+12);
    values.set(decodeGeometryUv(asset,"uv2",vertex) ?? [0,0],at+16);
    values.set(decodeGeometryPosition(asset,vertex),at+20); values[at+23]=1;
  }
  return new Uint8Array(values.buffer);
}
