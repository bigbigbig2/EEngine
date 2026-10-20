// EEngine C ABI; pinned Basis Universal resampler is unchanged.
#include "basisu_resampler.h"
#include <algorithm>
#include <cmath>
#include <cstdint>
#include <vector>

static float linear(float v) { return v <= .04045f ? v / 12.92f : std::pow((v + .055f) / 1.055f, 2.4f); }
static float encoded(float v) { return v <= .0031308f ? v * 12.92f : 1.055f * std::pow(v, 1.f / 2.4f) - .055f; }

// Tent with scale capped at dst/src gives bilinear pixel-centre sampling, matching
// the existing Linear / LinearNormal producer instead of a new antialias filter.
extern "C" int image_resample(const uint8_t* src, uint32_t sw, uint32_t sh,
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
