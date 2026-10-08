// EEngine glue; algorithms are unmodified pinned Basis Universal sources.
#include "basisu_bc7e_scalar.h"
#include "basisu_bc15_spmd.h"
#include "basisu_resampler.h"
#include "basisu_transcoder.h"
#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <vector>

namespace basisu { bool g_cpu_supports_sse41 = false; }

extern "C" int bc_encode(const uint8_t* rgba, uint32_t w, uint32_t h,
                          uint32_t format, uint32_t srgb, uint32_t channel, uint8_t* out) {
    if (!rgba || !out || !w || !h || w > 16384 || h > 16384 || channel > 3 ||
        (format != 7 && format != 4)) return 0;
    static const bool initialized = (bc7e_scalar::bc7e_compress_block_init(), true);
    (void)initialized;
    bc7e_scalar::bc7e_compress_block_params params;
    bc7e_scalar::bc7e_compress_block_params_init_slowest(&params, srgb != 0);
    // Same quality6 perceptual/linear weights as upstream's direct BC7 packer.
    const uint32_t bw = (w + 3) / 4, bh = (h + 3) / 4;
    for (uint32_t by = 0; by < bh; ++by) {
        for (uint32_t bx = 0; bx < bw; ++bx) {
            alignas(8) uint32_t pixels[16];
            uint8_t scalar[16];
            for (uint32_t y = 0; y < 4; ++y) {
                for (uint32_t x = 0; x < 4; ++x) {
                    const uint8_t* p = rgba + 4 * (std::min(h - 1, by * 4 + y) * w + std::min(w - 1, bx * 4 + x));
                    std::memcpy(&pixels[y * 4 + x], p, 4);
                    scalar[y * 4 + x] = p[channel];
                }
            }
            uint8_t* block = out + (by * bw + bx) * (format == 7 ? 16 : 8);
            if (format == 7) {
                alignas(8) uint64_t bits[2];
                bc7e_scalar::bc7e_compress_blocks(1, bits, pixels, &params);
                std::memcpy(block, bits, 16);
            } else {
                basisu::bc_spmd::encode_bc4_scalar(block, scalar, 1, 1, true);
            }
        }
    }
    return 1;
}

// Reference/import decode uses upstream block decoding, never an EEngine decoder.
extern "C" int bc_decode(const uint8_t* blocks, uint32_t w, uint32_t h, uint32_t format, uint8_t* out) {
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

static float linear(float v) { return v <= .04045f ? v / 12.92f : std::pow((v + .055f) / 1.055f, 2.4f); }
static float encoded(float v) { return v <= .0031308f ? v * 12.92f : 1.055f * std::pow(v, 1.f / 2.4f) - .055f; }

// Tent with scale capped at dst/src gives bilinear pixel-centre sampling, matching
// the existing Linear / LinearNormal producer instead of a new antialias filter.
extern "C" int bc_resample(const uint8_t* src, uint32_t sw, uint32_t sh,
                            uint8_t* dst, uint32_t dw, uint32_t dh, uint32_t srgb, uint32_t normal) {
    if (!src || !dst || !sw || !sh || !dw || !dh || std::max({sw, sh, dw, dh}) > 16384) return 0;
    // Only normal RGB needs to survive until normalization. Other channels are
    // quantized as scanlines arrive, avoiding a full float RGBA scratch image.
    std::vector<float> normals(normal ? static_cast<size_t>(dw) * dh * 3 : 0);
    std::vector<float> line(sw);
    for (uint32_t c = 0; c < 4; ++c) {
        basisu::Resampler sampler(sw, sh, dw, dh, basisu::Resampler::BOUNDARY_CLAMP,
            0.f, 1.f, "tent", nullptr, nullptr, std::min(1.f, float(dw) / sw), std::min(1.f, float(dh) / sh));
        if (sampler.status() != basisu::Resampler::STATUS_OKAY) return 0;
        uint32_t oy = 0;
        for (uint32_t y = 0; y < sh; ++y) {
            for (uint32_t x = 0; x < sw; ++x) {
                float v = src[(y * sw + x) * 4 + c] / 255.f;
                line[x] = srgb && c < 3 ? linear(v) : v;
            }
            if (!sampler.put_line(line.data())) return 0;
            while (const float* result = sampler.get_line()) {
                if (oy >= dh) return 0;
                for (uint32_t x = 0; x < dw; ++x) {
                    if (normal && c < 3) normals[(oy * dw + x) * 3 + c] = result[x];
                    else {
                        float v = srgb && c < 3 ? encoded(result[x]) : result[x];
                        dst[(oy * dw + x) * 4 + c] = uint8_t(std::floor(std::clamp(v, 0.f, 1.f) * 255.f + .5f));
                    }
                }
                ++oy;
            }
        }
        if (oy != dh) return 0;
    }
    for (size_t p = 0; p < size_t(dw) * dh; ++p) {
        if (normal) {
            float xyz[3];
            float length2 = 0;
            for (int c = 0; c < 3; ++c) { xyz[c] = normals[p * 3 + c] * 2.f - 1.f; length2 += xyz[c] * xyz[c]; }
            // Deterministic neutral for the undefined zero-vector normalization.
            for (int c = 0; c < 3; ++c) {
                float v = length2 > 0 ? xyz[c] / std::sqrt(length2) * .5f + .5f : (c == 2 ? 1.f : .5f);
                dst[p * 4 + c] = uint8_t(std::floor(std::clamp(v, 0.f, 1.f) * 255.f + .5f));
            }
        }
    }
    return 1;
}
