#pragma once

#include "OegPackFormat.h"

#include <cstdint>

namespace oengine::asset {

// OEGPACK V3 is always little-endian. These overloads are the only binary
// record serialization boundary; native struct layout is never persisted.
void EncodeRecordV3(std::uint8_t* out, const OegPackHeaderV3& value);
void EncodeRecordV3(std::uint8_t* out, const GeometryAssetRecordV3& value);
void EncodeRecordV3(std::uint8_t* out, const GeometryHierarchyNodeV3& value);
void EncodeRecordV3(std::uint8_t* out, const GeometryGroupDirectoryV3& value);
void EncodeRecordV3(std::uint8_t* out, const GeometryPageDirectoryV3& value);
void EncodeRecordV3(std::uint8_t* out, const VertexFormatRecordV3& value);
void EncodeRecordV3(std::uint8_t* out, const GroupHeaderV3& value);
void EncodeRecordV3(std::uint8_t* out, const MeshletHeaderV3& value);
void EncodeRecordV3(std::uint8_t* out, std::uint32_t value);

void DecodeRecordV3(const std::uint8_t* in, OegPackHeaderV3* value);
void DecodeRecordV3(const std::uint8_t* in, GeometryAssetRecordV3* value);
void DecodeRecordV3(const std::uint8_t* in, GeometryHierarchyNodeV3* value);
void DecodeRecordV3(const std::uint8_t* in, GeometryGroupDirectoryV3* value);
void DecodeRecordV3(const std::uint8_t* in, GeometryPageDirectoryV3* value);
void DecodeRecordV3(const std::uint8_t* in, VertexFormatRecordV3* value);
void DecodeRecordV3(const std::uint8_t* in, GroupHeaderV3* value);
void DecodeRecordV3(const std::uint8_t* in, MeshletHeaderV3* value);
void DecodeRecordV3(const std::uint8_t* in, std::uint32_t* value);

}  // namespace oengine::asset
