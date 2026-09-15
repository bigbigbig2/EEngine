#pragma once

#include <array>
#include <cstddef>
#include <cstdint>
#include <string>
#include <vector>

namespace oengine::asset {

using Hash256 = std::array<std::uint8_t, 32>;

Hash256 Sha256(const void* bytes, std::size_t size);
Hash256 Sha256(const std::vector<std::uint8_t>& bytes);
Hash256 Sha256(const std::string& text);
std::string Hex(const Hash256& hash);
std::uint32_t Crc32(const void* bytes, std::size_t size);

class Sha256Builder {
public:
    void Add(const void* bytes, std::size_t size);
    void Add(const std::string& text);
    Hash256 Finish() const;

private:
    std::vector<std::uint8_t> bytes_;
};

}  // namespace oengine::asset
