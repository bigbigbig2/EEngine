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

#undef OENGINE_WEB_COOK_EXPORT
