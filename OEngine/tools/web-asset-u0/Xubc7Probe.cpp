#include "basisu_transcoder.h"
#include "basisu_xbc7_decoder.h"
#define ZSTD_STATIC_LINKING_ONLY
#include "zstd.h"
#include <cstdint>
#include <cstring>
#include <cstdlib>
extern "C" void u0_bc_init();

namespace {
constexpr uint32_t max_dim = 512;
volatile uintptr_t reserved_workspace = 0;
alignas(8) uint8_t zstd_workspace[128 * 1024];
struct Target { uint8_t* bytes; uint32_t bx, by; };

bool varint(const uint8_t* p, uint32_t n, uint32_t& at, uint32_t& value) {
    value = 0;
    for (uint32_t shift = 0; shift < 35; shift += 7) {
        if (at == n) return false;
        const uint8_t b = p[at++];
        if (shift == 28 && b > 15) return false;
        value |= uint32_t(b & 127) << shift;
        if (!(b & 128)) return true;
    }
    return false;
}

// This allocation-free gate runs BEFORE upstream's blob arena and logical image.
bool preflight(const uint8_t* p, uint32_t n, uint32_t w, uint32_t h) {
    if (!p || !w || !h || w > max_dim || h > max_dim || n < 3) return false;
    const uint32_t blocks = ((w + 3) / 4) * ((h + 3) / 4);
    if (n > blocks * 32 + 4096) return false;
    if (p[0] == 0xb8 || p[0] == 0xb9)
        return p[1] == (w + 3) / 4 && p[2] == (h + 3) / 4 && n == 3 + blocks * 16;
    if (p[0] != 0xb7 || !p[1] || p[1] > 26) return false;
    uint32_t at = 2, seen = 0, total = 0;
    bool header = false, commands = false;
    for (uint32_t i = 0; i < p[1]; ++i) {
        if (at >= n) return false;
        const uint8_t flag = p[at++], id = flag & 127;
        if (id >= 26 || (seen & (1u << id))) return false;
        seen |= 1u << id;
        uint32_t unpacked = 0, stored = 0;
        if (!varint(p, n, at, unpacked) || !unpacked) return false;
        if (flag & 128) {
            if (!varint(p, n, at, stored) || !stored || stored >= unpacked) return false;
        } else stored = unpacked;
        const uint32_t limit = blocks * 256 + 4096;
        if (unpacked > limit - total || stored > n - at) return false;
        total += unpacked;
        if (id == 0) {
            uint8_t hdr[7];
            if (unpacked != sizeof(hdr)) return false;
            // The selected dictionary-free writer stores its seven-byte header raw.
            if (flag & 128) return false;
            std::memcpy(hdr, p + at, sizeof(hdr));
            if ((hdr[0] | uint32_t(hdr[1]) << 8) != w ||
                (hdr[2] | uint32_t(hdr[3]) << 8) != h ||
                !hdr[4] || hdr[4] > 100 || (hdr[5] & ~1) || hdr[6] != 1) return false;
            header = true;
        }
        if (id == 1) { if (unpacked != blocks) return false; commands = true; }
        at += stored;
    }
    return header && commands && at == n - 1 && p[at] == basist::xbc7::BLOB_STREAM_MAGIC_END;
}

bool block(uint32_t x, uint32_t y, const basist::bc7u::log_bc7_block& value, void* data) {
    auto& t = *static_cast<Target*>(data);
    return x < t.bx && y < t.by && basist::bc7u::pack_bc7(value, t.bytes + (y * t.bx + x) * 16);
}
}

// Single-threaded one-shot decode needs a DCtx, not a window-sized streaming buffer.
extern "C" size_t u0_zstd_decompress(void* dst, size_t cap, const void* src, size_t n) {
    if (ZSTD_estimateDCtxSize() > sizeof(zstd_workspace) || ZSTD_getDictID_fromFrame(src, n) != 0 ||
        ZSTD_getFrameContentSize(src, n) != cap || ZSTD_findFrameCompressedSize(src, n) != n) return size_t(-1);
    ZSTD_DCtx* ctx = ZSTD_initStaticDCtx(zstd_workspace, sizeof(zstd_workspace));
    return ctx ? ZSTD_decompressDCtx(ctx, dst, cap, src, n) : size_t(-1);
}

extern "C" int u0_preflight(const uint8_t* p, uint32_t n, uint32_t w, uint32_t h) {
    return preflight(p, n, w, h);
}
extern "C" int u0_decode(const uint8_t* p, uint32_t n, uint32_t w, uint32_t h, uint8_t* out, uint32_t capacity) {
    if (!out || !preflight(p, n, w, h)) return 0;
    Target t{out, (w + 3) / 4, (h + 3) / 4};
    if (capacity != t.bx * t.by * 16) return 0;
    // Bounded probe workspace: refuse before upstream's non-try allocations.
    void* reservation = std::malloc(8 * 1024 * 1024);
    if (!reservation) return 0;
    reserved_workspace = reinterpret_cast<uintptr_t>(reservation);
    std::free(reservation);
    // Include the solid BC7 endpoint tables from uastc_init, but no HDR/ASTC tables.
    static bool initialized = false;
    if (!initialized) { u0_bc_init(); initialized = true; }
    return basist::xbc7::unpack_image(basist::xbc7::byte_span(p, n), nullptr, nullptr, block, &t);
}
extern "C" uint32_t u0_logical_block_bytes() { return sizeof(basist::bc7u::log_bc7_block); }
