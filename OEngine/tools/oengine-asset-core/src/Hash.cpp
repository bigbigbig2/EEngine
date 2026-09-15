#include "oengine_asset/Hash.h"

#include <algorithm>
#include <cstring>
#include <iomanip>
#include <sstream>

namespace oengine::asset {
namespace {

constexpr std::uint32_t RotateRight(std::uint32_t value, std::uint32_t bits) {
    return (value >> bits) | (value << (32u - bits));
}

constexpr std::uint32_t kRound[64] = {
    0x428a2f98u, 0x71374491u, 0xb5c0fbcfu, 0xe9b5dba5u,
    0x3956c25bu, 0x59f111f1u, 0x923f82a4u, 0xab1c5ed5u,
    0xd807aa98u, 0x12835b01u, 0x243185beu, 0x550c7dc3u,
    0x72be5d74u, 0x80deb1feu, 0x9bdc06a7u, 0xc19bf174u,
    0xe49b69c1u, 0xefbe4786u, 0x0fc19dc6u, 0x240ca1ccu,
    0x2de92c6fu, 0x4a7484aau, 0x5cb0a9dcu, 0x76f988dau,
    0x983e5152u, 0xa831c66du, 0xb00327c8u, 0xbf597fc7u,
    0xc6e00bf3u, 0xd5a79147u, 0x06ca6351u, 0x14292967u,
    0x27b70a85u, 0x2e1b2138u, 0x4d2c6dfcu, 0x53380d13u,
    0x650a7354u, 0x766a0abbu, 0x81c2c92eu, 0x92722c85u,
    0xa2bfe8a1u, 0xa81a664bu, 0xc24b8b70u, 0xc76c51a3u,
    0xd192e819u, 0xd6990624u, 0xf40e3585u, 0x106aa070u,
    0x19a4c116u, 0x1e376c08u, 0x2748774cu, 0x34b0bcb5u,
    0x391c0cb3u, 0x4ed8aa4au, 0x5b9cca4fu, 0x682e6ff3u,
    0x748f82eeu, 0x78a5636fu, 0x84c87814u, 0x8cc70208u,
    0x90befffau, 0xa4506cebu, 0xbef9a3f7u, 0xc67178f2u,
};

std::uint32_t ReadBig32(const std::uint8_t* p) {
    return (std::uint32_t(p[0]) << 24u) | (std::uint32_t(p[1]) << 16u) |
           (std::uint32_t(p[2]) << 8u) | std::uint32_t(p[3]);
}

void WriteBig32(std::uint8_t* p, std::uint32_t value) {
    p[0] = std::uint8_t(value >> 24u);
    p[1] = std::uint8_t(value >> 16u);
    p[2] = std::uint8_t(value >> 8u);
    p[3] = std::uint8_t(value);
}

}  // namespace

Hash256 Sha256(const void* bytes, std::size_t size) {
    const auto* input = static_cast<const std::uint8_t*>(bytes);
    const std::uint64_t bitCount = std::uint64_t(size) * 8ull;
    const std::size_t paddedSize = ((size + 9u + 63u) / 64u) * 64u;
    std::vector<std::uint8_t> padded(paddedSize, 0u);
    if (size != 0u) std::memcpy(padded.data(), input, size);
    padded[size] = 0x80u;
    for (std::uint32_t i = 0; i < 8u; ++i) {
        padded[paddedSize - 1u - i] = std::uint8_t(bitCount >> (i * 8u));
    }

    std::uint32_t state[8] = {
        0x6a09e667u, 0xbb67ae85u, 0x3c6ef372u, 0xa54ff53au,
        0x510e527fu, 0x9b05688cu, 0x1f83d9abu, 0x5be0cd19u,
    };
    for (std::size_t block = 0; block < paddedSize; block += 64u) {
        std::uint32_t words[64]{};
        for (std::uint32_t i = 0; i < 16u; ++i) {
            words[i] = ReadBig32(padded.data() + block + i * 4u);
        }
        for (std::uint32_t i = 16u; i < 64u; ++i) {
            const std::uint32_t s0 = RotateRight(words[i - 15u], 7u) ^
                                     RotateRight(words[i - 15u], 18u) ^
                                     (words[i - 15u] >> 3u);
            const std::uint32_t s1 = RotateRight(words[i - 2u], 17u) ^
                                     RotateRight(words[i - 2u], 19u) ^
                                     (words[i - 2u] >> 10u);
            words[i] = words[i - 16u] + s0 + words[i - 7u] + s1;
        }
        std::uint32_t a = state[0], b = state[1], c = state[2], d = state[3];
        std::uint32_t e = state[4], f = state[5], g = state[6], h = state[7];
        for (std::uint32_t i = 0; i < 64u; ++i) {
            const std::uint32_t s1 = RotateRight(e, 6u) ^ RotateRight(e, 11u) ^ RotateRight(e, 25u);
            const std::uint32_t choice = (e & f) ^ (~e & g);
            const std::uint32_t temp1 = h + s1 + choice + kRound[i] + words[i];
            const std::uint32_t s0 = RotateRight(a, 2u) ^ RotateRight(a, 13u) ^ RotateRight(a, 22u);
            const std::uint32_t majority = (a & b) ^ (a & c) ^ (b & c);
            const std::uint32_t temp2 = s0 + majority;
            h = g; g = f; f = e; e = d + temp1;
            d = c; c = b; b = a; a = temp1 + temp2;
        }
        state[0] += a; state[1] += b; state[2] += c; state[3] += d;
        state[4] += e; state[5] += f; state[6] += g; state[7] += h;
    }
    Hash256 output{};
    for (std::uint32_t i = 0; i < 8u; ++i) WriteBig32(output.data() + i * 4u, state[i]);
    return output;
}

Hash256 Sha256(const std::vector<std::uint8_t>& bytes) {
    return Sha256(bytes.data(), bytes.size());
}

Hash256 Sha256(const std::string& text) {
    return Sha256(text.data(), text.size());
}

std::string Hex(const Hash256& hash) {
    std::ostringstream out;
    out << std::hex << std::setfill('0');
    for (std::uint8_t byte : hash) out << std::setw(2) << unsigned(byte);
    return out.str();
}

std::uint32_t Crc32(const void* bytes, std::size_t size) {
    const auto* input = static_cast<const std::uint8_t*>(bytes);
    std::uint32_t crc = 0xffffffffu;
    for (std::size_t i = 0; i < size; ++i) {
        crc ^= input[i];
        for (std::uint32_t bit = 0; bit < 8u; ++bit) {
            crc = (crc >> 1u) ^ (0xedb88320u & (0u - (crc & 1u)));
        }
    }
    return ~crc;
}

void Sha256Builder::Add(const void* bytes, std::size_t size) {
    const auto* input = static_cast<const std::uint8_t*>(bytes);
    bytes_.insert(bytes_.end(), input, input + size);
}

void Sha256Builder::Add(const std::string& text) { Add(text.data(), text.size()); }
Hash256 Sha256Builder::Finish() const { return Sha256(bytes_); }

}  // namespace oengine::asset
