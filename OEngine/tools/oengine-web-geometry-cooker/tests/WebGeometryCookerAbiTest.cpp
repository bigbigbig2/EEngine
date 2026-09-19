#include "oengine_web_geometry_cooker/WebGeometryCookerAbi.h"

#include "oengine_asset/GeometryAbi.h"
#include "oengine_asset/GeometryCookRecipe.h"
#include "oengine_asset/DecodedGeometryProduct.h"
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
    U32(bytes, 8u, 2u); U32(bytes, 12u, 96u);
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
    U32(bytes, 8u, 2u); U32(bytes, 12u, 128u); U32(bytes, 16u, totalBytes);
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

std::vector<std::uint8_t> CanonicalDomains(std::size_t domainCount) {
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
    const std::size_t domainVertexCount = positions.size();
    const std::size_t domainIndexCount = indices.size();
    const std::size_t vertexCount = domainVertexCount * domainCount;
    const std::size_t indexCount = domainIndexCount * domainCount;
    const std::size_t domainOffset = 128u;
    const std::size_t vertexOffset = AlignUp(domainOffset + domainCount * 32u, 16u);
    const std::size_t indexOffset = AlignUp(vertexOffset + vertexCount * 72u, 16u);
    const std::size_t totalBytes = AlignUp(indexOffset + indexCount * 4u, 16u);
    std::vector<std::uint8_t> bytes(totalBytes, 0u);
    const std::uint8_t magic[8] = {'O','E','W','G','C','A','N',0};
    std::copy(magic, magic + 8u, bytes.begin());
    U32(bytes, 8u, 2u); U32(bytes, 12u, 128u); U32(bytes, 16u, totalBytes);
    U32(bytes, 20u, std::uint32_t(domainCount)); U32(bytes, 24u, std::uint32_t(vertexCount)); U32(bytes, 28u, std::uint32_t(indexCount));
    U32(bytes, 32u, domainOffset); U32(bytes, 36u, vertexOffset); U32(bytes, 40u, indexOffset);
    U32(bytes, 44u, 72u); U32(bytes, 48u, 32u);
    for (std::size_t domain = 0u; domain < domainCount; ++domain) {
        const std::size_t at = domainOffset + domain * 32u;
        U32(bytes, at, std::uint32_t(7u + domain));
        U32(bytes, at + 4u, kMeshletOpaque | kMeshletCastsShadow);
        U16(bytes, at + 8u, kAttributePosition);
        U16(bytes, at + 10u, 1u);
        U32(bytes, at + 12u, std::uint32_t(domain * domainVertexCount));
        U32(bytes, at + 16u, std::uint32_t(domainVertexCount));
        U32(bytes, at + 20u, std::uint32_t(domain * domainIndexCount));
        U32(bytes, at + 24u, std::uint32_t(domainIndexCount));
        for (std::size_t vertex = 0u; vertex < domainVertexCount; ++vertex) {
            const std::size_t target = vertexOffset + (domain * domainVertexCount + vertex) * 72u;
            for (std::size_t axis = 0u; axis < 3u; ++axis) F32(bytes, target + axis * 4u, positions[vertex][axis] + float(domain) * 4.0f);
            F32(bytes, target + 24u, 1.0f); F32(bytes, target + 36u, 1.0f);
            for (std::size_t channel = 0u; channel < 4u; ++channel) F32(bytes, target + 56u + channel * 4u, 1.0f);
        }
        for (std::size_t index = 0u; index < domainIndexCount; ++index) U32(bytes, indexOffset + (domain * domainIndexCount + index) * 4u, indices[index]);
    }
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

/**
 * Page identity must depend on Group payload content and order only. These
 * cases pin the two properties the incremental publication design relies on:
 * identity is computable from payload digests alone, and it is independent of
 * any page-level packing or padding.
 */
void AssertPageIdentityRollup() {
    const std::vector<std::uint32_t> groupIds{4u, 7u, 9u};
    const std::vector<std::uint32_t> payloadBytes{128u, 256u, 64u};
    const std::vector<Hash256> digests{
        Sha256(std::string("payload-a")),
        Sha256(std::string("payload-b")),
        Sha256(std::string("payload-c"))};

    const std::array<std::uint8_t, 16> baseline =
        ComputeGeometryPageIdentityV1(groupIds, payloadBytes, digests);

    // Deterministic across repeated evaluation.
    assert(ComputeGeometryPageIdentityV1(groupIds, payloadBytes, digests) == baseline);

    // Sensitive to payload content: changing one Group payload digest changes identity.
    std::vector<Hash256> mutatedDigests = digests;
    mutatedDigests[1] = Sha256(std::string("payload-b-mutated"));
    assert(ComputeGeometryPageIdentityV1(groupIds, payloadBytes, mutatedDigests) != baseline);

    // Sensitive to payload length.
    std::vector<std::uint32_t> mutatedBytes = payloadBytes;
    mutatedBytes[2] = 65u;
    assert(ComputeGeometryPageIdentityV1(groupIds, mutatedBytes, digests) != baseline);

    // Order-sensitive: the same Group set in a different ascending order that
    // carries different payloads is a different page.
    const std::vector<std::uint32_t> reorderedIds{5u, 8u, 9u};
    const std::vector<std::uint32_t> reorderedBytes{256u, 128u, 64u};
    const std::vector<Hash256> reorderedDigests{digests[1], digests[0], digests[2]};
    assert(ComputeGeometryPageIdentityV1(reorderedIds, reorderedBytes, reorderedDigests) != baseline);

    // Non-ascending GroupID order is rejected rather than silently normalised.
    bool descendingRejected = false;
    try {
        ComputeGeometryPageIdentityV1({7u, 4u, 9u}, reorderedBytes, reorderedDigests);
    } catch (const std::runtime_error&) {
        descendingRejected = true;
    }
    assert(descendingRejected);

    // Duplicate GroupID is rejected as well.
    bool duplicateRejected = false;
    try {
        ComputeGeometryPageIdentityV1({4u, 4u, 9u}, payloadBytes, digests);
    } catch (const std::runtime_error&) {
        duplicateRejected = true;
    }
    assert(duplicateRejected);

    // Mismatched input lengths are rejected.
    bool lengthRejected = false;
    try {
        ComputeGeometryPageIdentityV1(groupIds, payloadBytes, {digests[0]});
    } catch (const std::runtime_error&) {
        lengthRejected = true;
    }
    assert(lengthRejected);

    // An empty page is not addressable.
    bool emptyRejected = false;
    try {
        ComputeGeometryPageIdentityV1({}, {}, {});
    } catch (const std::runtime_error&) {
        emptyRejected = true;
    }
    assert(emptyRejected);

    std::cout << "page identity rollup: ok" << std::endl;
}

/**
 * ADR-0017 two-phase ABI: the descriptor stage must freeze the complete ID graph
 * without producing payload, and the payload stage must tolerate out-of-order,
 * repeated and undeclared PageIDs while reproducing the monolithic cook exactly.
 */
void AssertTwoPhaseParity(
    const std::vector<std::uint8_t>& canonical,
    const std::vector<std::uint8_t>& recipe) {
    const std::uintptr_t monolithic = oengine_web_geometry_cook(
        canonical.data(), canonical.size(), recipe.data(), recipe.size(), 8u * 1024u * 1024u);
    if (!monolithic) throw std::runtime_error(LastError());
    const std::uintptr_t planned = oengine_web_geometry_cook_plan(
        canonical.data(), canonical.size(), recipe.data(), recipe.size(), 8u * 1024u * 1024u);
    if (!planned) throw std::runtime_error(LastError());

    const std::uint32_t pageCount = oengine_web_geometry_cook_page_count(planned);
    assert(pageCount > 0u);
    assert(pageCount == oengine_web_geometry_cook_page_count(monolithic));

    // Descriptor stage must already freeze every descriptor-only section.
    for (std::uint32_t section = OENGINE_WEB_COOK_SECTION_ASSET_RECORDS;
         section <= OENGINE_WEB_COOK_SECTION_RECIPE_HASH; ++section) {
        assert(Section(planned, section) == Section(monolithic, section));
    }
    assert(oengine_web_geometry_cook_section_size(
        planned, OENGINE_WEB_COOK_SECTION_PAGE_BYTES, 0u) == kGeometryPageBytesV3);

    // Before any produce call every declared page is PENDING, not missing.
    for (std::uint32_t page = 0u; page < pageCount; ++page) {
        assert(oengine_web_geometry_cook_page_status(planned, page) ==
               OENGINE_WEB_COOK_PAGE_PENDING);
    }
    // An undeclared PageID is refused and must not extend the ID graph.
    assert(oengine_web_geometry_cook_page_status(planned, pageCount) ==
           OENGINE_WEB_COOK_PAGE_UNDECLARED);
    assert(oengine_web_geometry_cook_page_status(planned, pageCount + 4096u) ==
           OENGINE_WEB_COOK_PAGE_UNDECLARED);
    assert(oengine_web_geometry_cook_page_count(planned) == pageCount);

    std::vector<std::uint8_t> page(kGeometryPageBytesV3, 0u);
    const std::vector<std::uint8_t> monolithicPage =
        Section(monolithic, OENGINE_WEB_COOK_SECTION_PAGE_BYTES, 0u);

    // Producing the last PageID first proves out-of-order production.
    assert(oengine_web_geometry_cook_produce_page(
        planned, pageCount - 1u, page.data(), page.size()) == OENGINE_WEB_COOK_PAGE_READY);
    assert(page == Section(monolithic, OENGINE_WEB_COOK_SECTION_PAGE_BYTES, pageCount - 1u));
    assert(oengine_web_geometry_cook_page_status(planned, pageCount - 1u) ==
           OENGINE_WEB_COOK_PAGE_READY);

    // Producing undeclared ids must be refused and must leave the destination untouched.
    std::fill(page.begin(), page.end(), std::uint8_t(0xa5));
    assert(oengine_web_geometry_cook_produce_page(
        planned, pageCount, page.data(), page.size()) == OENGINE_WEB_COOK_PAGE_UNDECLARED);
    assert(std::all_of(page.begin(), page.end(), [](std::uint8_t value) {
        return value == std::uint8_t(0xa5);
    }));

    // A repeated produce returns the byte-identical payload.
    assert(oengine_web_geometry_cook_produce_page(
        planned, pageCount - 1u, page.data(), page.size()) == OENGINE_WEB_COOK_PAGE_READY);
    assert(page == Section(monolithic, OENGINE_WEB_COOK_SECTION_PAGE_BYTES, pageCount - 1u));

    // Fill the rest in ascending order and compare every page to the monolithic cook.
    for (std::uint32_t pageIndex = 0u; pageIndex < pageCount; ++pageIndex) {
        assert(oengine_web_geometry_cook_produce_page(
            planned, pageIndex, page.data(), page.size()) == OENGINE_WEB_COOK_PAGE_READY);
        assert(page == Section(monolithic, OENGINE_WEB_COOK_SECTION_PAGE_BYTES, pageIndex));
    }
    for (std::uint32_t pageIndex = 0u; pageIndex < pageCount; ++pageIndex) {
        assert(oengine_web_geometry_cook_page_status(planned, pageIndex) ==
               OENGINE_WEB_COOK_PAGE_READY);
    }

    // Two plans of the same input must agree on the whole ID graph.
    const std::uintptr_t plannedAgain = oengine_web_geometry_cook_plan(
        canonical.data(), canonical.size(), recipe.data(), recipe.size(), 8u * 1024u * 1024u);
    if (!plannedAgain) throw std::runtime_error(LastError());
    for (std::uint32_t section = OENGINE_WEB_COOK_SECTION_ASSET_RECORDS;
         section <= OENGINE_WEB_COOK_SECTION_RECIPE_HASH; ++section) {
        assert(Section(planned, section) == Section(plannedAgain, section));
    }
    oengine_web_geometry_cook_destroy(plannedAgain);
    oengine_web_geometry_cook_destroy(planned);
    oengine_web_geometry_cook_destroy(monolithic);
}

int main() {
    AssertPageIdentityRollup();
    assert(oengine_web_geometry_cook_abi_version() == 2u);
    const std::vector<std::uint8_t> canonical = CanonicalCube();
    const std::vector<std::uint8_t> recipe = Recipe();
    // Golden freeze of the fixture encoding itself: these digests pin the exact
    // recipe/canonical byte layout (including the ABI version word) so that any
    // accidental edit to the fixture is caught before it can mask a real
    // regression in the cooker.
    assert(Hex(Sha256(canonical)) == "bf445f9207ee9a3a76a7656bbc1a31aaac36efab1c64dea489423d84f28e6a29");
    assert(Hex(Sha256(recipe)) == "4c7311b0954eb9592036cb3e135464e1001e11949876dfe4de9460179c5db01b");
    AssertTwoPhaseParity(canonical, recipe);
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
    assert(Section(first, OENGINE_WEB_COOK_SECTION_CONTENT_MANIFEST_HASH).size() == 32u);
    for (std::uint32_t group = 0u; group < groups.size() / 16u; ++group) {
        assert(U32(groups, group * 16u) < pageCount);
    }
    for (std::uint32_t page = 0u; page < pageCount; ++page) {
        const std::vector<std::uint8_t> pageBytes = Section(first, OENGINE_WEB_COOK_SECTION_PAGE_BYTES, page);
        assert(pageBytes.size() == kGeometryPageBytesV3);
        // Page identity is rolled up from Group payloads, so it is deliberately
        // NOT the whole-page digest. Both must stay independently verifiable.
        const Hash256 wholePageHash = Sha256(pageBytes);
        assert(!std::equal(
            wholePageHash.begin(), wholePageHash.begin() + 16u,
            pageRecords.begin() + page * 32u));
        assert(U32(pageRecords, page * 32u + 20u) > 0u);
        assert(U32(pageRecords, page * 32u + 24u) == 0u);
        assert(U32(pageRecords, page * 32u + 28u) == 0u);
    }
    for (std::uint32_t section = OENGINE_WEB_COOK_SECTION_ASSET_RECORDS;
         section <= OENGINE_WEB_COOK_SECTION_RECIPE_HASH; ++section) {
        assert(Section(first, section) == Section(second, section));
    }
    assert(Section(first, OENGINE_WEB_COOK_SECTION_CONTENT_MANIFEST_HASH) ==
           Section(second, OENGINE_WEB_COOK_SECTION_CONTENT_MANIFEST_HASH));
    for (std::uint32_t page = 0u; page < pageCount; ++page) {
        assert(Section(first, OENGINE_WEB_COOK_SECTION_PAGE_BYTES, page) ==
               Section(second, OENGINE_WEB_COOK_SECTION_PAGE_BYTES, page));
    }

    // The Web profile emits one Product asset per canonical material domain so
    // a GLB mesh's primitives stay independently addressable by instance.
    const std::vector<std::uint8_t> twoDomains = CanonicalDomains(2u);
    const std::uintptr_t multi = oengine_web_geometry_cook(
        twoDomains.data(), twoDomains.size(), recipe.data(), recipe.size(),
        8u * 1024u * 1024u);
    if (!multi) throw std::runtime_error(LastError());
    assert(Section(multi, OENGINE_WEB_COOK_SECTION_ASSET_RECORDS).size() == 256u);
    assert(Section(multi, OENGINE_WEB_COOK_SECTION_ROOT_NODE_IDS).size() >= 8u);
    oengine_web_geometry_cook_destroy(multi);

    // A multi-mesh GLB can exceed the 255 vertex-format limit of a single merged
    // asset. Each domain must therefore stay its own asset.
    constexpr std::size_t manyDomains = 260u;
    const std::vector<std::uint8_t> many = CanonicalDomains(manyDomains);
    const std::uintptr_t manyHandle = oengine_web_geometry_cook(
        many.data(), many.size(), recipe.data(), recipe.size(),
        64u * 1024u * 1024u);
    if (!manyHandle) throw std::runtime_error(LastError());
    assert(Section(manyHandle, OENGINE_WEB_COOK_SECTION_ASSET_RECORDS).size() == manyDomains * 128u);
    oengine_web_geometry_cook_destroy(manyHandle);

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
