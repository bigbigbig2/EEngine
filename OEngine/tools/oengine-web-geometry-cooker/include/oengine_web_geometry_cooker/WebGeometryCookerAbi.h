#pragma once

#include <cstddef>
#include <cstdint>

enum OengineWebGeometryCookSectionV1 : std::uint32_t {
    OENGINE_WEB_COOK_SECTION_ASSET_RECORDS = 1u,
    OENGINE_WEB_COOK_SECTION_ROOT_NODE_IDS = 2u,
    OENGINE_WEB_COOK_SECTION_HIERARCHY_NODES = 3u,
    OENGINE_WEB_COOK_SECTION_GROUP_DIRECTORY = 4u,
    OENGINE_WEB_COOK_SECTION_PAGE_RECORDS = 5u,
    OENGINE_WEB_COOK_SECTION_BOOTSTRAP_PAGE_IDS = 6u,
    OENGINE_WEB_COOK_SECTION_VERTEX_FORMATS = 7u,
    OENGINE_WEB_COOK_SECTION_RECIPE_HASH = 8u,
    OENGINE_WEB_COOK_SECTION_PAGE_BYTES = 9u,
    OENGINE_WEB_COOK_SECTION_CONTENT_MANIFEST_HASH = 10u,
};

/** Result codes for the two-phase payload stage. */
enum OengineWebGeometryCookPageStatusV1 : std::uint32_t {
    /** The page payload was produced (or was already produced) and copied. */
    OENGINE_WEB_COOK_PAGE_READY = 1u,
    /** The descriptor declares this PageID but its payload is not produced yet. */
    OENGINE_WEB_COOK_PAGE_PENDING = 2u,
    /** The descriptor does not declare this PageID; the ID graph is not extended. */
    OENGINE_WEB_COOK_PAGE_UNDECLARED = 3u,
};

#if defined(__EMSCRIPTEN__)
#include <emscripten/emscripten.h>
#define OENGINE_WEB_COOK_EXPORT extern "C" EMSCRIPTEN_KEEPALIVE
#elif defined(_WIN32)
#define OENGINE_WEB_COOK_EXPORT extern "C" __declspec(dllexport)
#else
#define OENGINE_WEB_COOK_EXPORT extern "C" __attribute__((visibility("default")))
#endif

OENGINE_WEB_COOK_EXPORT std::uint32_t oengine_web_geometry_cook_abi_version();
OENGINE_WEB_COOK_EXPORT std::uintptr_t oengine_web_geometry_cook(
    const std::uint8_t* canonicalInput,
    std::size_t canonicalInputBytes,
    const std::uint8_t* recipeInput,
    std::size_t recipeInputBytes,
    std::uint64_t maxDecodedProductBytes);
OENGINE_WEB_COOK_EXPORT void oengine_web_geometry_cook_destroy(std::uintptr_t handle);
OENGINE_WEB_COOK_EXPORT std::size_t oengine_web_geometry_cook_section_size(
    std::uintptr_t handle,
    std::uint32_t section,
    std::uint32_t index);
OENGINE_WEB_COOK_EXPORT std::uint32_t oengine_web_geometry_cook_copy_section(
    std::uintptr_t handle,
    std::uint32_t section,
    std::uint32_t index,
    std::uint8_t* output,
    std::size_t outputBytes);
OENGINE_WEB_COOK_EXPORT std::uint32_t oengine_web_geometry_cook_page_count(
    std::uintptr_t handle);
OENGINE_WEB_COOK_EXPORT std::size_t oengine_web_geometry_cook_last_error_size();
OENGINE_WEB_COOK_EXPORT std::uint32_t oengine_web_geometry_cook_copy_last_error(
    char* output,
    std::size_t outputBytes);

/**
 * Descriptor stage of the two-phase ABI (ADR-0017).
 *
 * Freezes the complete ID graph — page count, per-PageID identity, page-to-Group
 * mapping and the activation cut — without producing any page payload. The
 * returned handle supports every read-only query the monolithic handle does
 * (section sizes, page count, descriptor sections) as well as the payload-stage
 * entry points below. Querying PAGE_BYTES on a descriptor-stage handle reports
 * every declared page as PENDING rather than failing.
 *
 * Rejects the same inputs as `oengine_web_geometry_cook`; on failure returns 0
 * and sets the thread-local error.
 */
OENGINE_WEB_COOK_EXPORT std::uintptr_t oengine_web_geometry_cook_plan(
    const std::uint8_t* canonicalInput,
    std::size_t canonicalInputBytes,
    const std::uint8_t* recipeInput,
    std::size_t recipeInputBytes,
    std::uint64_t maxDecodedProductBytes);

/**
 * Payload stage: advances one PageID and reports whether its payload is ready.
 *
 * Must tolerate out-of-order, repeated and concurrent calls. Repeating a PageID
 * returns the byte-identical payload already produced. Returns one of
 * `OengineWebGeometryCookPageStatusV1`; on READY, `outputBytes` must be exactly
 * the decoded page size and the payload is copied into `output`. On PENDING or
 * UNDECLARED nothing is written.
 *
 * A declared but not-yet-produced page is PENDING; a PageID the descriptor never
 * declared is UNDECLARED and must not extend the ID graph.
 */
OENGINE_WEB_COOK_EXPORT std::uint32_t oengine_web_geometry_cook_produce_page(
    std::uintptr_t handle,
    std::uint32_t pageId,
    std::uint8_t* output,
    std::size_t outputBytes);

/**
 * Payload stage: reports readiness for one PageID without producing anything.
 * Returns one of `OengineWebGeometryCookPageStatusV1`.
 */
OENGINE_WEB_COOK_EXPORT std::uint32_t oengine_web_geometry_cook_page_status(
    std::uintptr_t handle,
    std::uint32_t pageId);

#undef OENGINE_WEB_COOK_EXPORT
