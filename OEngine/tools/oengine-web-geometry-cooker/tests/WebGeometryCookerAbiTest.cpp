#include "oengine_web_geometry_cooker/WebGeometryCookerAbi.h"

#include "oengine_asset/GeometryAbi.h"
#include "oengine_asset/GeometryCookRecipe.h"
#include "oengine_asset/Hash.h"

#include <algorithm>
#include <array>
#include <cassert>
#include <cstdint>
#include <cstring>
#include <iostream>
#include <stdexcept>
#include <vector>

namespace {

using namespace oengine::asset;

constexpr std::size_t AlignUp(std::size_t value, std::size_t alignment) {
    return (value + alignment - 1u) & ~(alignment - 1u);
}

void U16(std::vector<std::uint8_t>& bytes, std::size_t at, std::uint16_t value) {
    bytes[at] = std::uint8_t(value);
    bytes[at + 1u] = std::uint8_t(value >> 8u);
}

void U32(std::vector<std::uint8_t>& bytes, std::size_t at, std::uint32_t value) {
    for (std::uint32_t i = 0u; i < 4u; ++i) bytes[at + i] = std::uint8_t(value >> (i * 8u));
}

std::uint32_t U32(const std::vector<std::uint8_t>& bytes, std::size_t at) {
    std::uint32_t value = 0u;
    for (std::uint32_t i = 0u; i < 4u; ++i) value |= std::uint32_t(bytes[at + i]) << (i * 8u);
    return value;
}

void F32(std::vector<std::uint8_t>& bytes, std::size_t at, float value) {
    std::uint32_t bits = 0u;
    std::memcpy(&bits, &value, sizeof(bits));
    U32(bytes, at, bits);
}

std::vector<std::uint8_t> Recipe() {
    std::vector<std::uint8_t> bytes(96u, 0u);
    const std::uint8_t magic[8] = {'O','E','W','G','R','C','P',0};
    std::copy(magic, magic + 8u, bytes.begin());
    U32(bytes, 8u, 1u); U32(bytes, 12u, 96u);
    U32(bytes, 16u, 64u); U32(bytes, 20u, 32u); U32(bytes, 24u, 128u);
    U32(bytes, 28u, 32u); F32(bytes, 32u, 0.0f); F32(bytes, 36u, 2.0f);
    F32(bytes, 40u, 0.5f); F32(bytes, 44u, 0.51f); F32(bytes, 48u, 0.85f);
    U32(bytes, 52u, 3u); F32(bytes, 56u, 2.0f); F32(bytes, 60u, 0.01f);
    F32(bytes, 64u, 1.5f); U32(bytes, 68u, 8u); U32(bytes, 72u, 18u);
    U32(bytes, 76u, 256u); U32(bytes, 80u, 64u * 1024u * 1024u);
    U32(bytes, 84u, 0u); U32(bytes, 88u, 0u);
    return bytes;
}

std::vector<std::uint8_t> CanonicalCube() {
    constexpr std::array<std::array<float, 3>, 8> positions = {{
        {{-1.0f,-1.0f,-1.0f}}, {{1.0f,-1.0f,-1.0f}},
        {{1.0f,1.0f,-1.0f}}, {{-1.0f,1.0f,-1.0f}},
        {{-1.0f,-1.0f,1.0f}}, {{1.0f,-1.0f,1.0f}},
        {{1.0f,1.0f,1.0f}}, {{-1.0f,1.0f,1.0f}}
    }};
    constexpr std::array<std::uint32_t, 36> indices = {{
        0,2,1, 0,3,2, 4,5,6, 4,6,7, 0,1,5, 0,5,4,
        1,2,6, 1,6,5, 2,3,7, 2,7,6, 3,0,4, 3,4,7
    }};
    constexpr std::size_t domainOffset = 128u;
    constexpr std::size_t vertexOffset = 160u;
    constexpr std::size_t indexOffset = AlignUp(vertexOffset + positions.size() * 72u, 16u);
    constexpr std::size_t totalBytes = AlignUp(indexOffset + indices.size() * 4u, 16u);
    std::vector<std::uint8_t> bytes(totalBytes, 0u);
    const std::uint8_t magic[8] = {'O','E','W','G','C','A','N',0};
    std::copy(magic, magic + 8u, bytes.begin());
    U32(bytes, 8u, 1u); U32(bytes, 12u, 128u); U32(bytes, 16u, totalBytes);
    U32(bytes, 20u, 1u); U32(bytes, 24u, positions.size()); U32(bytes, 28u, indices.size());
    U32(bytes, 32u, domainOffset); U32(bytes, 36u, vertexOffset); U32(bytes, 40u, indexOffset);
    U32(bytes, 44u, 72u); U32(bytes, 48u, 32u);
    U32(bytes, domainOffset, 7u);
    U32(bytes, domainOffset + 4u, kMeshletOpaque | kMeshletCastsShadow);
    U16(bytes, domainOffset + 8u, kAttributePosition);
    U16(bytes, domainOffset + 10u, 1u);
    U32(bytes, domainOffset + 12u, 0u); U32(bytes, domainOffset + 16u, positions.size());
    U32(bytes, domainOffset + 20u, 0u); U32(bytes, domainOffset + 24u, indices.size());
    for (std::size_t vertex = 0u; vertex < positions.size(); ++vertex) {
        const std::size_t at = vertexOffset + vertex * 72u;
        for (std::size_t axis = 0u; axis < 3u; ++axis) F32(bytes, at + axis * 4u, positions[vertex][axis]);
        F32(bytes, at + 24u, 1.0f); F32(bytes, at + 36u, 1.0f);
        for (std::size_t channel = 0u; channel < 4u; ++channel) F32(bytes, at + 56u + channel * 4u, 1.0f);
    }
    for (std::size_t index = 0u; index < indices.size(); ++index) U32(bytes, indexOffset + index * 4u, indices[index]);
    return bytes;
}

std::string LastError() {
    const std::size_t size = oengine_web_geometry_cook_last_error_size();
    std::string value(size, '\0');
    if (size) assert(oengine_web_geometry_cook_copy_last_error(value.data(), size) == 1u);
    return value;
}

std::vector<std::uint8_t> Section(
    std::uintptr_t handle, std::uint32_t section, std::uint32_t index = 0u) {
    const std::size_t size = oengine_web_geometry_cook_section_size(handle, section, index);
    if (size == 0u) throw std::runtime_error(LastError());
    std::vector<std::uint8_t> bytes(size);
    if (!oengine_web_geometry_cook_copy_section(handle, section, index, bytes.data(), bytes.size())) {
        throw std::runtime_error(LastError());
    }
    return bytes;
}

}  // namespace

int main() {
    assert(oengine_web_geometry_cook_abi_version() == 1u);
    const std::vector<std::uint8_t> canonical = CanonicalCube();
    const std::vector<std::uint8_t> recipe = Recipe();
    assert(Hex(Sha256(canonical)) == "ef3d47d2ca6e355184bc540928ca0663910c27d3bbdac0d43187ed998e4df822");
    assert(Hex(Sha256(recipe)) == "43d244b5d0453b36e076d340ee8cc8ef69550fbc9265eb6959b70cdbda85e44c");
    const std::uintptr_t first = oengine_web_geometry_cook(
        canonical.data(), canonical.size(), recipe.data(), recipe.size(), 8u * 1024u * 1024u);
    if (!first) throw std::runtime_error(LastError());
    const std::uintptr_t second = oengine_web_geometry_cook(
        canonical.data(), canonical.size(), recipe.data(), recipe.size(), 8u * 1024u * 1024u);
    if (!second) throw std::runtime_error(LastError());

    const std::uint32_t pageCount = oengine_web_geometry_cook_page_count(first);
    assert(pageCount > 0u);
    assert(Section(first, OENGINE_WEB_COOK_SECTION_ASSET_RECORDS).size() == 128u);
    assert(Section(first, OENGINE_WEB_COOK_SECTION_ROOT_NODE_IDS).size() >= 4u);
    assert(Section(first, OENGINE_WEB_COOK_SECTION_HIERARCHY_NODES).size() % 48u == 0u);
    const std::vector<std::uint8_t> groups = Section(first, OENGINE_WEB_COOK_SECTION_GROUP_DIRECTORY);
    const std::vector<std::uint8_t> pageRecords = Section(first, OENGINE_WEB_COOK_SECTION_PAGE_RECORDS);
    assert(groups.size() % 16u == 0u);
    assert(pageRecords.size() == std::size_t(pageCount) * 32u);
    assert(Section(first, OENGINE_WEB_COOK_SECTION_BOOTSTRAP_PAGE_IDS).size() >= 4u);
    assert(Section(first, OENGINE_WEB_COOK_SECTION_VERTEX_FORMATS).size() % 16u == 0u);
    assert(Section(first, OENGINE_WEB_COOK_SECTION_RECIPE_HASH).size() == 32u);
    for (std::uint32_t group = 0u; group < groups.size() / 16u; ++group) {
        assert(U32(groups, group * 16u) < pageCount);
    }
    for (std::uint32_t page = 0u; page < pageCount; ++page) {
        const std::vector<std::uint8_t> pageBytes = Section(first, OENGINE_WEB_COOK_SECTION_PAGE_BYTES, page);
        assert(pageBytes.size() == kGeometryPageBytesV3);
        const Hash256 hash = Sha256(pageBytes);
        assert(std::equal(hash.begin(), hash.begin() + 16u, pageRecords.begin() + page * 32u));
        assert(U32(pageRecords, page * 32u + 20u) > 0u);
        assert(U32(pageRecords, page * 32u + 24u) == 0u);
        assert(U32(pageRecords, page * 32u + 28u) == 0u);
    }
    for (std::uint32_t section = OENGINE_WEB_COOK_SECTION_ASSET_RECORDS;
         section <= OENGINE_WEB_COOK_SECTION_RECIPE_HASH; ++section) {
        assert(Section(first, section) == Section(second, section));
    }
    for (std::uint32_t page = 0u; page < pageCount; ++page) {
        assert(Section(first, OENGINE_WEB_COOK_SECTION_PAGE_BYTES, page) ==
               Section(second, OENGINE_WEB_COOK_SECTION_PAGE_BYTES, page));
    }

    std::vector<std::uint8_t> corrupt = canonical;
    U32(corrupt, 16u, std::uint32_t(corrupt.size() - 16u));
    assert(oengine_web_geometry_cook(
        corrupt.data(), corrupt.size(), recipe.data(), recipe.size(),
        8u * 1024u * 1024u) == 0u);
    assert(!LastError().empty());
    assert(oengine_web_geometry_cook(
        canonical.data(), canonical.size(), recipe.data(), recipe.size(),
        kGeometryPageBytesV3 - 1u) == 0u);
    assert(!LastError().empty());

    oengine_web_geometry_cook_destroy(second);
    oengine_web_geometry_cook_destroy(first);
    std::cout << "web geometry cooker ABI oracle passed\n";
    return 0;
}
