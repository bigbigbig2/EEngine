#pragma once

#include "OegPackFormat.h"

#include <cstdint>

namespace oengine::asset {

// OEGPACK V3 is always little-endian. These overloads are the only binary
// record serialization boundary; native struct layout is never persisted.
void EncodeRecordV4(std::uint8_t* out, const OegPackHeaderV4& value);
void EncodeRecordV4(std::uint8_t* out, const GeometryAssetRecordV4& value);
void EncodeRecordV4(std::uint8_t* out, const GeometryHierarchyNodeV4& value);
void EncodeRecordV4(std::uint8_t* out, const GeometryGroupDirectoryV4& value);
void EncodeRecordV4(std::uint8_t* out, const GeometryPageDirectoryV4& value);
void EncodeRecordV4(std::uint8_t* out, const VertexFormatRecordV4& value);
void EncodeRecordV4(std::uint8_t* out, const GroupHeaderV4& value);
void EncodeRecordV4(std::uint8_t* out, const MeshletHeaderV4& value);
void EncodeRecordV4(std::uint8_t* out, std::uint32_t value);

void DecodeRecordV4(const std::uint8_t* in, OegPackHeaderV4* value);
void DecodeRecordV4(const std::uint8_t* in, GeometryAssetRecordV4* value);
void DecodeRecordV4(const std::uint8_t* in, GeometryHierarchyNodeV4* value);
void DecodeRecordV4(const std::uint8_t* in, GeometryGroupDirectoryV4* value);
void DecodeRecordV4(const std::uint8_t* in, GeometryPageDirectoryV4* value);
void DecodeRecordV4(const std::uint8_t* in, VertexFormatRecordV4* value);
void DecodeRecordV4(const std::uint8_t* in, GroupHeaderV4* value);
void DecodeRecordV4(const std::uint8_t* in, MeshletHeaderV4* value);
void DecodeRecordV4(const std::uint8_t* in, std::uint32_t* value);

}  // namespace oengine::asset
