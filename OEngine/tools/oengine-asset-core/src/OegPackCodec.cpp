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

void EncodeRecordV4(std::uint8_t* out, const OegPackHeaderV4& v) {
    std::fill(out, out + 256u, 0u); std::copy(v.magic, v.magic + 8u, out);
    const std::uint32_t fields[] = {v.formatMajor,v.formatMinor,v.endianMarker,v.headerBytes,v.pageShift,v.pageBytes,v.flags,v.defaultCodec,v.assetCount,v.rootNodeIndexCount,v.hierarchyNodeCount,v.groupCount,v.pageCount,v.vertexFormatCount,v.bootstrapPageCount,v.reserved0};
    for (std::uint32_t i = 0u; i < 16u; ++i) U32(out, 8u + i * 4u, fields[i]);
    const std::uint64_t offsets[] = {v.assetDirectoryOffset,v.rootNodeIndexOffset,v.hierarchyOffset,v.groupDirectoryOffset,v.pageDirectoryOffset,v.vertexFormatOffset,v.bootstrapPageOffset,v.pageBlobOffset,v.fileBytes};
    for (std::uint32_t i = 0u; i < 9u; ++i) U64(out, 72u + i * 8u, offsets[i]);
    std::copy(v.recipeHash, v.recipeHash + 32u, out + 144u); std::copy(v.packContentHash, v.packContentHash + 32u, out + 176u);
    U64(out, 208u, v.querySectionOffset); U64(out, 216u, v.querySectionBytes);
}
void DecodeRecordV4(const std::uint8_t* in, OegPackHeaderV4* v) {
    *v = {}; std::copy(in, in + 8u, v->magic);
    std::uint32_t* fields[] = {&v->formatMajor,&v->formatMinor,&v->endianMarker,&v->headerBytes,&v->pageShift,&v->pageBytes,&v->flags,&v->defaultCodec,&v->assetCount,&v->rootNodeIndexCount,&v->hierarchyNodeCount,&v->groupCount,&v->pageCount,&v->vertexFormatCount,&v->bootstrapPageCount,&v->reserved0};
    for (std::uint32_t i = 0u; i < 16u; ++i) *fields[i] = U32(in, 8u + i * 4u);
    std::uint64_t* offsets[] = {&v->assetDirectoryOffset,&v->rootNodeIndexOffset,&v->hierarchyOffset,&v->groupDirectoryOffset,&v->pageDirectoryOffset,&v->vertexFormatOffset,&v->bootstrapPageOffset,&v->pageBlobOffset,&v->fileBytes};
    for (std::uint32_t i = 0u; i < 9u; ++i) *offsets[i] = U64(in, 72u + i * 8u);
    std::copy(in + 144u, in + 176u, v->recipeHash); std::copy(in + 176u, in + 208u, v->packContentHash);
    v->querySectionOffset = U64(in, 208u); v->querySectionBytes = U64(in, 216u);
    std::copy(in + 224u, in + 256u, v->reserved);
}

void EncodeRecordV4(std::uint8_t* out, const GeometryAssetRecordV4& v) {
    std::fill(out, out + 128u, 0u); std::copy(v.assetId, v.assetId + 32u, out); PutFloats(out,32u,v.boundsSphere); PutFloats(out,48u,v.boundsMin); PutFloats(out,60u,v.boundsMax);
    const std::uint32_t fields[] = {v.rootNodeBegin,v.rootNodeCount,v.hierarchyBegin,v.hierarchyCount,v.groupBegin,v.groupCount,v.bootstrapPageBegin,v.bootstrapPageCount,v.sourceTriangleCount,v.leafMeshletCount,v.totalMeshletCount,v.flags,v.reserved[0],v.reserved[1]};
    for (std::uint32_t i = 0u; i < 14u; ++i) U32(out,72u+i*4u,fields[i]);
}
void DecodeRecordV4(const std::uint8_t* in, GeometryAssetRecordV4* v) {
    *v={}; std::copy(in,in+32u,v->assetId); GetFloats(in,32u,v->boundsSphere); GetFloats(in,48u,v->boundsMin); GetFloats(in,60u,v->boundsMax);
    std::uint32_t* fields[] = {&v->rootNodeBegin,&v->rootNodeCount,&v->hierarchyBegin,&v->hierarchyCount,&v->groupBegin,&v->groupCount,&v->bootstrapPageBegin,&v->bootstrapPageCount,&v->sourceTriangleCount,&v->leafMeshletCount,&v->totalMeshletCount,&v->flags,&v->reserved[0],&v->reserved[1]};
    for(std::uint32_t i=0u;i<14u;++i)*fields[i]=U32(in,72u+i*4u);
}
void EncodeRecordV4(std::uint8_t* out,const GeometryHierarchyNodeV4& v){std::fill(out,out+48u,0u);PutFloats(out,0u,v.boundsSphere);PutFloats(out,16u,v.bboxMin);PutFloats(out,28u,v.bboxMax);F32(out,40u,v.maxParentError);U32(out,44u,v.packedNodeData);}
void DecodeRecordV4(const std::uint8_t* in,GeometryHierarchyNodeV4* v){*v={};GetFloats(in,0u,v->boundsSphere);GetFloats(in,16u,v->bboxMin);GetFloats(in,28u,v->bboxMax);v->maxParentError=F32(in,40u);v->packedNodeData=U32(in,44u);}
void EncodeRecordV4(std::uint8_t* out,const GeometryGroupDirectoryV4& v){U32(out,0u,v.pageId);U32(out,4u,v.offsetInDecodedPage);U32(out,8u,v.payloadBytes);U32(out,12u,v.flags);}
void DecodeRecordV4(const std::uint8_t* in,GeometryGroupDirectoryV4* v){v->pageId=U32(in,0u);v->offsetInDecodedPage=U32(in,4u);v->payloadBytes=U32(in,8u);v->flags=U32(in,12u);}
void EncodeRecordV4(std::uint8_t* out,const GeometryPageDirectoryV4& v){std::fill(out,out+64u,0u);U64(out,0u,v.compressedFileOffset);U32(out,8u,v.compressedBytes);U32(out,12u,v.decodedBytes);U32(out,16u,v.firstGroup);U32(out,20u,v.groupCount);U32(out,24u,v.codec);U32(out,28u,v.flags);std::copy(v.decodedContentHash128,v.decodedContentHash128+16u,out+32u);U32(out,48u,v.compressedChecksum);U32(out,52u,v.reserved0);U64(out,56u,v.reserved1);}
void DecodeRecordV4(const std::uint8_t* in,GeometryPageDirectoryV4* v){*v={};v->compressedFileOffset=U64(in,0u);v->compressedBytes=U32(in,8u);v->decodedBytes=U32(in,12u);v->firstGroup=U32(in,16u);v->groupCount=U32(in,20u);v->codec=U32(in,24u);v->flags=U32(in,28u);std::copy(in+32u,in+48u,v->decodedContentHash128);v->compressedChecksum=U32(in,48u);v->reserved0=U32(in,52u);v->reserved1=U64(in,56u);}
void EncodeRecordV4(std::uint8_t* out,const VertexFormatRecordV4& v){std::fill(out,out+16u,0u);U16(out,0u,v.streamBytesPerVertex);U16(out,2u,v.attributeMask);out[4]=v.positionOffset;out[5]=v.normalOffset;out[6]=v.tangentOffset;out[7]=v.uv0Offset;out[8]=v.uv1Offset;out[9]=v.colorOffset;out[10]=v.positionEncoding;out[11]=v.tangentSignEncoding;std::copy(v.reserved,v.reserved+4u,out+12u);}
void DecodeRecordV4(const std::uint8_t* in,VertexFormatRecordV4* v){*v={};v->streamBytesPerVertex=U16(in,0u);v->attributeMask=U16(in,2u);v->positionOffset=in[4];v->normalOffset=in[5];v->tangentOffset=in[6];v->uv0Offset=in[7];v->uv1Offset=in[8];v->colorOffset=in[9];v->positionEncoding=in[10];v->tangentSignEncoding=in[11];std::copy(in+12u,in+16u,v->reserved);}
void EncodeRecordV4(std::uint8_t* out,const GroupHeaderV4& v){std::fill(out,out+64u,0u);PutFloats(out,0u,v.boundsSphere);PutFloats(out,16u,v.bboxMin);PutFloats(out,28u,v.bboxMax);F32(out,40u,v.parentError);U16(out,44u,v.meshletCount);out[46]=v.lodLevel;out[47]=v.vertexFormatId;U32(out,48u,v.meshletHeaderOffset);U32(out,52u,v.triangleDataOffset);U32(out,56u,v.vertexDataOffset);U32(out,60u,v.payloadBytes);}
void DecodeRecordV4(const std::uint8_t* in,GroupHeaderV4* v){*v={};GetFloats(in,0u,v->boundsSphere);GetFloats(in,16u,v->bboxMin);GetFloats(in,28u,v->bboxMax);v->parentError=F32(in,40u);v->meshletCount=U16(in,44u);v->lodLevel=in[46];v->vertexFormatId=in[47];v->meshletHeaderOffset=U32(in,48u);v->triangleDataOffset=U32(in,52u);v->vertexDataOffset=U32(in,56u);v->payloadBytes=U32(in,60u);}
void EncodeRecordV4(std::uint8_t* out,const MeshletHeaderV4& v){std::fill(out,out+layout_v4::meshletHeaderBytes,0u);out[layout_v4::meshlet_vertexCount]=v.vertexCount;out[layout_v4::meshlet_triangleCount]=v.triangleCount;U16(out,layout_v4::meshlet_flags,v.flags);U32(out,layout_v4::meshlet_vertexByteOffset,v.vertexByteOffset);U32(out,layout_v4::meshlet_triangleByteOffset,v.triangleByteOffset);U32(out,layout_v4::meshlet_refineGroupId,v.refineGroupId);U32(out,layout_v4::meshlet_materialId,v.materialId);PutFloats(out,layout_v4::meshlet_bboxMin,v.bboxMin);PutFloats(out,layout_v4::meshlet_bboxMax,v.bboxMax);}
void DecodeRecordV4(const std::uint8_t* in,MeshletHeaderV4* v){*v={};v->vertexCount=in[layout_v4::meshlet_vertexCount];v->triangleCount=in[layout_v4::meshlet_triangleCount];v->flags=U16(in,layout_v4::meshlet_flags);v->vertexByteOffset=U32(in,layout_v4::meshlet_vertexByteOffset);v->triangleByteOffset=U32(in,layout_v4::meshlet_triangleByteOffset);v->refineGroupId=U32(in,layout_v4::meshlet_refineGroupId);v->materialId=U32(in,layout_v4::meshlet_materialId);GetFloats(in,layout_v4::meshlet_bboxMin,v->bboxMin);GetFloats(in,layout_v4::meshlet_bboxMax,v->bboxMax);}
void EncodeRecordV4(std::uint8_t* out,std::uint32_t v){U32(out,0u,v);}
void DecodeRecordV4(const std::uint8_t* in,std::uint32_t* v){*v=U32(in,0u);}

}  // namespace oengine::asset
