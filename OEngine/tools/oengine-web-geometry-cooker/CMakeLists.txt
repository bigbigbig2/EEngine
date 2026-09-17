cmake_minimum_required(VERSION 3.24)
project(oengine_web_geometry_cooker LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
set(NYX_SOURCE_DIR "D:/Nyx-main" CACHE PATH "Pinned local Nyx source root")
set(OENGINE_WEB_COOK_INITIAL_MEMORY_MB 64 CACHE STRING "Initial portable-single WASM memory")
set(OENGINE_WEB_COOK_MAXIMUM_MEMORY_MB 512 CACHE STRING "Maximum portable-single WASM memory")

function(require_nyx_sha256 relative expected)
    set(source "${NYX_SOURCE_DIR}/${relative}")
    if(NOT EXISTS "${source}")
        message(FATAL_ERROR "Missing pinned Nyx source: ${source}")
    endif()
    file(SHA256 "${source}" actual)
    string(TOLOWER "${actual}" actual)
    if(NOT actual STREQUAL expected)
        message(FATAL_ERROR "Nyx source identity mismatch for ${relative}: ${actual}")
    endif()
endfunction()

require_nyx_sha256("MiniEngine/Model/MeshletBuilder.cpp" "b749346382b0f9a1574f0c0566a2860bff2acfbc6521df6f153a42653c81e84a")
require_nyx_sha256("MiniEngine/Model/ModelConvert.cpp" "8bdf016e0f36e70f0c1aa46d679ab0e1b4f57ea30e0748a6549675620cc8a059")
require_nyx_sha256("MiniEngine/Model/MeshletStructs.h" "1edfaa25d2e12067b98d93599142b110e2509be96471fa09a00b029484ef9b23")
require_nyx_sha256("MiniEngine/Model/GeometryStreaming.cpp" "acb3aa4786eb6367e92b99e9e295c83e0aade516d59578f23ff38496f838a072")
require_nyx_sha256("MiniEngine/Model/GeometryStreaming.h" "4bee73ffc0c29ad7670bb7c5ac1567a281b3f33271adfc534d834dc88897c264")
require_nyx_sha256("MiniEngine/Model/Shaders/DAGCull.slang" "6534dd8794248d693acd07488653a625df3b4fac11117f96537a43857dcfee7e")
require_nyx_sha256("MiniEngine/Model/Shaders/VBufferMesh.slang" "9f374a2437d5ab939ae4d98289c150097bdab17305191ff97abf3fd1d13c621d")
require_nyx_sha256("MiniEngine/ThirdParty/meshoptimizer/meshoptimizer.h" "a05dfed026d1dbeea6b38751ff22397e48a6706a4138e92a160ad57e33f7c0fd")

get_filename_component(OENGINE_DIR "${CMAKE_CURRENT_SOURCE_DIR}/../.." ABSOLUTE)
set(ASSET_CORE_DIR "${CMAKE_CURRENT_SOURCE_DIR}/../oengine-asset-core")
set(MESHOPTIMIZER_DIR "${NYX_SOURCE_DIR}/MiniEngine/ThirdParty/meshoptimizer")
file(GLOB MESHOPTIMIZER_SOURCES CONFIGURE_DEPENDS "${MESHOPTIMIZER_DIR}/*.cpp")

set(WEB_COOKER_SOURCES
    src/WebGeometryCookerAbi.cpp
    "${ASSET_CORE_DIR}/src/Hash.cpp"
    "${ASSET_CORE_DIR}/src/GeometryCookRecipe.cpp"
    "${ASSET_CORE_DIR}/src/OegPackCodec.cpp"
    "${ASSET_CORE_DIR}/src/geometry/CanonicalGeometry.cpp"
    "${ASSET_CORE_DIR}/src/geometry/GeometryCooker.cpp"
    "${ASSET_CORE_DIR}/src/product/DecodedGeometryProduct.cpp"
    ${MESHOPTIMIZER_SOURCES})

add_executable(oengine-web-geometry-cooker ${WEB_COOKER_SOURCES})
target_include_directories(oengine-web-geometry-cooker PRIVATE
    include
    "${ASSET_CORE_DIR}/include"
    "${MESHOPTIMIZER_DIR}")
target_compile_options(oengine-web-geometry-cooker PRIVATE
    -Wall -Wextra -fno-fast-math -ffp-contract=off -fexceptions)

if(EMSCRIPTEN)
    math(EXPR OENGINE_WEB_COOK_INITIAL_MEMORY_BYTES "${OENGINE_WEB_COOK_INITIAL_MEMORY_MB} * 1024 * 1024")
    math(EXPR OENGINE_WEB_COOK_MAXIMUM_MEMORY_BYTES "${OENGINE_WEB_COOK_MAXIMUM_MEMORY_MB} * 1024 * 1024")
    set_target_properties(oengine-web-geometry-cooker PROPERTIES SUFFIX ".mjs")
    target_link_options(oengine-web-geometry-cooker PRIVATE
        --no-entry
        -fexceptions
        -sWASM=1
        -sMODULARIZE=1
        -sEXPORT_ES6=1
        -sENVIRONMENT=worker
        -sFILESYSTEM=0
        "-sEXPORTED_RUNTIME_METHODS=['HEAPU8']"
        -sWASM_BIGINT=1
        -sALLOW_MEMORY_GROWTH=1
        "-sINITIAL_MEMORY=${OENGINE_WEB_COOK_INITIAL_MEMORY_BYTES}"
        "-sMAXIMUM_MEMORY=${OENGINE_WEB_COOK_MAXIMUM_MEMORY_BYTES}"
        "-sEXPORTED_FUNCTIONS=['_malloc','_free','_oengine_web_geometry_cook_abi_version','_oengine_web_geometry_cook','_oengine_web_geometry_cook_destroy','_oengine_web_geometry_cook_section_size','_oengine_web_geometry_cook_copy_section','_oengine_web_geometry_cook_page_count','_oengine_web_geometry_cook_last_error_size','_oengine_web_geometry_cook_copy_last_error']")
else()
    target_sources(oengine-web-geometry-cooker PRIVATE tests/WebGeometryCookerAbiTest.cpp)
endif()
