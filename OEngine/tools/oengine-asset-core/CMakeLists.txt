cmake_minimum_required(VERSION 3.24)
project(oengine_asset_core LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
set(NYX_SOURCE_DIR "D:/Nyx-main" CACHE PATH "Pinned local Nyx source root")

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
require_nyx_sha256("MiniEngine/Model/Shaders/DAGCull.slang" "6534dd8794248d693acd07488653a625df3b4fac11117f96537a43857dcfee7e")
require_nyx_sha256("MiniEngine/ThirdParty/meshoptimizer/meshoptimizer.h" "a05dfed026d1dbeea6b38751ff22397e48a6706a4138e92a160ad57e33f7c0fd")
require_nyx_sha256("MiniEngine/ThirdParty/lz4/lz4.c" "aba04f8c20e7f7396bed55e0ee041f762d9ee123e175d1b48cf8a9533a360074")
require_nyx_sha256("MiniEngine/ThirdParty/cgltf/cgltf.h" "123d322d3eff8db5dc34a690131037a89972dff91793050caa48353a5911b4d7")

file(GLOB MESHOPTIMIZER_SOURCES CONFIGURE_DEPENDS
    "${NYX_SOURCE_DIR}/MiniEngine/ThirdParty/meshoptimizer/*.cpp")

add_executable(oengine-asset-cooker
    cli/main.cpp
    src/Hash.cpp
    src/GeometryCookRecipe.cpp
    src/OegPackCodec.cpp
    src/import/GltfImporter.cpp
    src/geometry/GeometryCooker.cpp
    src/package/OegPackWriter.cpp
    "${NYX_SOURCE_DIR}/MiniEngine/ThirdParty/lz4/lz4.c"
    ${MESHOPTIMIZER_SOURCES})

target_include_directories(oengine-asset-cooker PRIVATE
    include
    "${NYX_SOURCE_DIR}/MiniEngine/ThirdParty/cgltf"
    "${NYX_SOURCE_DIR}/MiniEngine/ThirdParty/lz4"
    "${NYX_SOURCE_DIR}/MiniEngine/ThirdParty/meshoptimizer")

if(MSVC)
    target_compile_options(oengine-asset-cooker PRIVATE /W4 /fp:precise)
else()
    target_compile_options(oengine-asset-cooker PRIVATE -Wall -Wextra -fno-fast-math)
endif()

if(WIN32)
    target_link_libraries(oengine-asset-cooker PRIVATE Psapi)
endif()
