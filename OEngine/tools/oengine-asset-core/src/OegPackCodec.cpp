#include "oengine_asset/OegPackCodec.h"

#include <algorithm>
#include <cstring>

namespace oengine::asset {
namespace {

void U16(std::uint8_t* out, std::uint32_t at, std::uint16_t value) {
    out[at] = std::uint8_t(value); out[at + 1u] = std::uint8_t(value >> 8u);
}
void U32(std::uint8_t* out, std::uint32_t at, std::uint32_t value) {
    for (std::uint32_t i = 0u; i < 4u; ++i) out[at + i] = std::uint8_t(value >> (i * 8u));
}
void U64(std::uint8_t* out, std::uint32_t at, std::uint64_t value) {
    for (std::uint32_t i = 0u; i < 8u; ++i) out[at + i] = std::uint8_t(value >> (i * 8u));
}
void F32(std::uint8_t* out, std::uint32_t at, float value) {
    std::uint32_t bits = 0u; std::memcpy(&bits, &value, sizeof(bits)); U32(out, at, bits);
}
std::uint16_t U16(const std::uint8_t* in, std::uint32_t at) {
    return std::uint16_t(in[at]) | (std::uint16_t(in[at + 1u]) << 8u);
}
std::uint32_t U32(const std::uint8_t* in, std::uint32_t at) {
    std::uint32_t value = 0u; for (std::uint32_t i = 0u; i < 4u; ++i) value |= std::uint32_t(in[at + i]) << (i * 8u); return value;
}
std::uint64_t U64(const std::uint8_t* in, std::uint32_t at) {
    std::uint64_t value = 0u; for (std::uint32_t i = 0u; i < 8u; ++i) value |= std::uint64_t(in[at + i]) << (i * 8u); return value;
}
float F32(const std::uint8_t* in, std::uint32_t at) {
    const std::uint32_t bits = U32(in, at); float value = 0.0f; std::memcpy(&value, &bits, sizeof(value)); return value;
}
template <std::size_t N> void PutFloats(std::uint8_t* out, std::uint32_t at, const float (&values)[N]) {
    for (std::uint32_t i = 0u; i < N; ++i) F32(out, at + i * 4u, values[i]);
}
template <std::size_t N> void GetFloats(const std::uint8_t* in, std::uint32_t at, float (&values)[N]) {
    for (std::uint32_t i = 0u; i < N; ++i) values[i] = F32(in, at + i * 4u);
}

}  // namespace

void EncodeRecordV3(std::uint8_t* out, const OegPackHeaderV3& v) {
    std::fill(out, out + 256u, 0u); std::copy(v.magic, v.magic + 8u, out);
    const std::uint32_t fields[] = {v.formatMajor,v.formatMinor,v.endianMarker,v.headerBytes,v.pageShift,v.pageBytes,v.flags,v.defaultCodec,v.assetCount,v.rootNodeIndexCount,v.hierarchyNodeCount,v.groupCount,v.pageCount,v.vertexFormatCount,v.bootstrapPageCount,v.reserved0};
    for (std::uint32_t i = 0u; i < 16u; ++i) U32(out, 8u + i * 4u, fields[i]);
    const std::uint64_t offsets[] = {v.assetDirectoryOffset,v.rootNodeIndexOffset,v.hierarchyOffset,v.groupDirectoryOffset,v.pageDirectoryOffset,v.vertexFormatOffset,v.bootstrapPageOffset,v.pageBlobOffset,v.fileBytes};
    for (std::uint32_t i = 0u; i < 9u; ++i) U64(out, 72u + i * 8u, offsets[i]);
    std::copy(v.recipeHash, v.recipeHash + 32u, out + 144u); std::copy(v.packContentHash, v.packContentHash + 32u, out + 176u);
}
void DecodeRecordV3(const std::uint8_t* in, OegPackHeaderV3* v) {
    *v = {}; std::copy(in, in + 8u, v->magic);
    std::uint32_t* fields[] = {&v->formatMajor,&v->formatMinor,&v->endianMarker,&v->headerBytes,&v->pageShift,&v->pageBytes,&v->flags,&v->defaultCodec,&v->assetCount,&v->rootNodeIndexCount,&v->hierarchyNodeCount,&v->groupCount,&v->pageCount,&v->vertexFormatCount,&v->bootstrapPageCount,&v->reserved0};
    for (std::uint32_t i = 0u; i < 16u; ++i) *fields[i] = U32(in, 8u + i * 4u);
    std::uint64_t* offsets[] = {&v->assetDirectoryOffset,&v->rootNodeIndexOffset,&v->hierarchyOffset,&v->groupDirectoryOffset,&v->pageDirectoryOffset,&v->vertexFormatOffset,&v->bootstrapPageOffset,&v->pageBlobOffset,&v->fileBytes};
    for (std::uint32_t i = 0u; i < 9u; ++i) *offsets[i] = U64(in, 72u + i * 8u);
    std::copy(in + 144u, in + 176u, v->recipeHash); std::copy(in + 176u, in + 208u, v->packContentHash); std::copy(in + 208u, in + 256u, v->reserved);
}

void EncodeRecordV3(std::uint8_t* out, const GeometryAssetRecordV3& v) {
    std::fill(out, out + 128u, 0u); std::copy(v.assetId, v.assetId + 32u, out); PutFloats(out,32u,v.boundsSphere); PutFloats(out,48u,v.boundsMin); PutFloats(out,60u,v.boundsMax);
    const std::uint32_t fields[] = {v.rootNodeBegin,v.rootNodeCount,v.hierarchyBegin,v.hierarchyCount,v.groupBegin,v.groupCount,v.bootstrapPageBegin,v.bootstrapPageCount,v.sourceTriangleCount,v.leafMeshletCount,v.totalMeshletCount,v.flags,v.reserved[0],v.reserved[1]};
    for (std::uint32_t i = 0u; i < 14u; ++i) U32(out,72u+i*4u,fields[i]);
}
void DecodeRecordV3(const std::uint8_t* in, GeometryAssetRecordV3* v) {
    *v={}; std::copy(in,in+32u,v->assetId); GetFloats(in,32u,v->boundsSphere); GetFloats(in,48u,v->boundsMin); GetFloats(in,60u,v->boundsMax);
    std::uint32_t* fields[] = {&v->rootNodeBegin,&v->rootNodeCount,&v->hierarchyBegin,&v->hierarchyCount,&v->groupBegin,&v->groupCount,&v->bootstrapPageBegin,&v->bootstrapPageCount,&v->sourceTriangleCount,&v->leafMeshletCount,&v->totalMeshletCount,&v->flags,&v->reserved[0],&v->reserved[1]};
    for(std::uint32_t i=0u;i<14u;++i)*fields[i]=U32(in,72u+i*4u);
}
void EncodeRecordV3(std::uint8_t* out,const GeometryHierarchyNodeV3& v){std::fill(out,out+48u,0u);PutFloats(out,0u,v.boundsSphere);PutFloats(out,16u,v.bboxMin);PutFloats(out,28u,v.bboxMax);F32(out,40u,v.maxParentError);U32(out,44u,v.packedNodeData);}
void DecodeRecordV3(const std::uint8_t* in,GeometryHierarchyNodeV3* v){*v={};GetFloats(in,0u,v->boundsSphere);GetFloats(in,16u,v->bboxMin);GetFloats(in,28u,v->bboxMax);v->maxParentError=F32(in,40u);v->packedNodeData=U32(in,44u);}
void EncodeRecordV3(std::uint8_t* out,const GeometryGroupDirectoryV3& v){U32(out,0u,v.pageId);U32(out,4u,v.offsetInDecodedPage);U32(out,8u,v.payloadBytes);U32(out,12u,v.flags);}
void DecodeRecordV3(const std::uint8_t* in,GeometryGroupDirectoryV3* v){v->pageId=U32(in,0u);v->offsetInDecodedPage=U32(in,4u);v->payloadBytes=U32(in,8u);v->flags=U32(in,12u);}
void EncodeRecordV3(std::uint8_t* out,const GeometryPageDirectoryV3& v){std::fill(out,out+64u,0u);U64(out,0u,v.compressedFileOffset);U32(out,8u,v.compressedBytes);U32(out,12u,v.decodedBytes);U32(out,16u,v.firstGroup);U32(out,20u,v.groupCount);U32(out,24u,v.codec);U32(out,28u,v.flags);std::copy(v.decodedContentHash128,v.decodedContentHash128+16u,out+32u);U32(out,48u,v.compressedChecksum);U32(out,52u,v.reserved0);U64(out,56u,v.reserved1);}
void DecodeRecordV3(const std::uint8_t* in,GeometryPageDirectoryV3* v){*v={};v->compressedFileOffset=U64(in,0u);v->compressedBytes=U32(in,8u);v->decodedBytes=U32(in,12u);v->firstGroup=U32(in,16u);v->groupCount=U32(in,20u);v->codec=U32(in,24u);v->flags=U32(in,28u);std::copy(in+32u,in+48u,v->decodedContentHash128);v->compressedChecksum=U32(in,48u);v->reserved0=U32(in,52u);v->reserved1=U64(in,56u);}
void EncodeRecordV3(std::uint8_t* out,const VertexFormatRecordV3& v){std::fill(out,out+16u,0u);U16(out,0u,v.strideBytes);U16(out,2u,v.attributeMask);out[4]=v.positionOffset;out[5]=v.normalOffset;out[6]=v.tangentOffset;out[7]=v.uv0Offset;out[8]=v.uv1Offset;out[9]=v.colorOffset;std::copy(v.reserved,v.reserved+6u,out+10u);}
void DecodeRecordV3(const std::uint8_t* in,VertexFormatRecordV3* v){*v={};v->strideBytes=U16(in,0u);v->attributeMask=U16(in,2u);v->positionOffset=in[4];v->normalOffset=in[5];v->tangentOffset=in[6];v->uv0Offset=in[7];v->uv1Offset=in[8];v->colorOffset=in[9];std::copy(in+10u,in+16u,v->reserved);}
void EncodeRecordV3(std::uint8_t* out,const GroupHeaderV3& v){std::fill(out,out+64u,0u);PutFloats(out,0u,v.boundsSphere);PutFloats(out,16u,v.bboxMin);PutFloats(out,28u,v.bboxMax);F32(out,40u,v.parentError);U16(out,44u,v.meshletCount);out[46]=v.lodLevel;out[47]=v.vertexFormatId;U32(out,48u,v.meshletHeaderOffset);U32(out,52u,v.triangleDataOffset);U32(out,56u,v.vertexDataOffset);U32(out,60u,v.payloadBytes);}
void DecodeRecordV3(const std::uint8_t* in,GroupHeaderV3* v){*v={};GetFloats(in,0u,v->boundsSphere);GetFloats(in,16u,v->bboxMin);GetFloats(in,28u,v->bboxMax);v->parentError=F32(in,40u);v->meshletCount=U16(in,44u);v->lodLevel=in[46];v->vertexFormatId=in[47];v->meshletHeaderOffset=U32(in,48u);v->triangleDataOffset=U32(in,52u);v->vertexDataOffset=U32(in,56u);v->payloadBytes=U32(in,60u);}
void EncodeRecordV3(std::uint8_t* out,const MeshletHeaderV3& v){std::fill(out,out+48u,0u);U16(out,0u,v.vertexCount);U16(out,2u,v.triangleCount);U32(out,4u,v.vertexByteOffset);U32(out,8u,v.triangleByteOffset);U32(out,12u,v.refineGroupId);U32(out,16u,v.materialId);U32(out,20u,v.flags);PutFloats(out,24u,v.bboxMin);PutFloats(out,36u,v.bboxMax);}
void DecodeRecordV3(const std::uint8_t* in,MeshletHeaderV3* v){*v={};v->vertexCount=U16(in,0u);v->triangleCount=U16(in,2u);v->vertexByteOffset=U32(in,4u);v->triangleByteOffset=U32(in,8u);v->refineGroupId=U32(in,12u);v->materialId=U32(in,16u);v->flags=U32(in,20u);GetFloats(in,24u,v->bboxMin);GetFloats(in,36u,v->bboxMax);}
void EncodeRecordV3(std::uint8_t* out,std::uint32_t v){U32(out,0u,v);}
void DecodeRecordV3(const std::uint8_t* in,std::uint32_t* v){*v=U32(in,0u);}

}  // namespace oengine::asset
