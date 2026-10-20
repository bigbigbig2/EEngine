// EEngine cold import C ABI; unchanged pinned Basis block decoders.
#include "basisu_transcoder.h"
#include <cstdint>
#include <cstring>

// Reference/import decode uses upstream block decoding, never an EEngine decoder.
extern "C" int image_decode(const uint8_t* blocks, uint32_t w, uint32_t h, uint32_t format, uint8_t* out) {
    if (!blocks || !out || !w || !h || (format != 7 && format != 4)) return 0;
    const uint32_t bw = (w + 3) / 4, bh = (h + 3) / 4;
    for (uint32_t by = 0; by < bh; ++by) {
        for (uint32_t bx = 0; bx < bw; ++bx) {
            basist::color_rgba pixels[16];
            const uint8_t* block = blocks + (by * bw + bx) * (format == 7 ? 16 : 8);
            if (format == 7) {
                if (!basist::bc7u::unpack_bc7(block, pixels)) return 0;
            } else {
                std::memset(pixels, 0, sizeof(pixels));
                basist::bcu::unpack_bc4(block, reinterpret_cast<uint8_t*>(pixels), 4);
                for (auto& p : pixels) p.a = 255;
            }
            for (uint32_t y = 0; y < 4 && by * 4 + y < h; ++y)
                for (uint32_t x = 0; x < 4 && bx * 4 + x < w; ++x)
                    std::memcpy(out + 4 * ((by * 4 + y) * w + bx * 4 + x), &pixels[y * 4 + x], 4);
        }
    }
    return 1;
}
