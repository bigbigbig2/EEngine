import { createHash } from "node:crypto";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const toolsDir = dirname(fileURLToPath(import.meta.url));
const engineDir = dirname(toolsDir);
const repoDir = dirname(engineDir);
const nyxRoot = resolve(process.env.NYX_SOURCE_DIR ?? "D:/Nyx-main");
const compiler = process.env.CXX ?? (process.platform === "win32" ? "D:/Devtool/mingw64/bin/g++.exe" : "g++");
const driver = join(toolsDir, "nyx-reference", "nyx_reference_main.cpp");
const sourceRoot = join(nyxRoot, "MiniEngine", "Model");
const meshoptimizerRoot = join(nyxRoot, "MiniEngine", "ThirdParty", "meshoptimizer");
// The header hash is checked by the source manifest; the generated harness only
// needs to verify the source implementation byte-for-byte before copying it.
const meshletBuilderBytes = await readFile(join(sourceRoot, "MeshletBuilder.cpp"));
const meshletBuilderHash = createHash("sha256").update(meshletBuilderBytes).digest("hex");
if (meshletBuilderHash !== "b749346382b0f9a1574f0c0566a2860bff2acfbc6521df6f153a42653c81e84a") {
  throw new Error(`Nyx MeshletBuilder.cpp hash mismatch: ${meshletBuilderHash}`);
}

const vectorStub = `#pragma once
#include <cmath>
namespace Math {
using Scalar = float;
class Vector3 {
public:
  float x = 0, y = 0, z = 0;
  Vector3() = default;
  explicit Vector3(float v) : x(v), y(v), z(v) {}
  Vector3(float xIn, float yIn, float zIn) : x(xIn), y(yIn), z(zIn) {}
  float GetX() const { return x; }
  float GetY() const { return y; }
  float GetZ() const { return z; }
  Vector3 operator+(Vector3 b) const { return {x + b.x, y + b.y, z + b.z}; }
  Vector3 operator-(Vector3 b) const { return {x - b.x, y - b.y, z - b.z}; }
  Vector3 operator*(float b) const { return {x * b, y * b, z * b}; }
  Vector3 operator/(float b) const { return {x / b, y / b, z / b}; }
};
class Vector4 {
public:
  float x = 0, y = 0, z = 0, w = 0;
  Vector4() = default;
  explicit Vector4(float v) : x(v), y(v), z(v), w(v) {}
  Vector4(float xIn, float yIn, float zIn, float wIn) : x(xIn), y(yIn), z(zIn), w(wIn) {}
  float GetX() const { return x; }
  float GetY() const { return y; }
  float GetZ() const { return z; }
  float GetW() const { return w; }
  Vector4 operator*(float b) const { return {x * b, y * b, z * b, w * b}; }
  Vector4 operator-(Vector4 b) const { return {x - b.x, y - b.y, z - b.z, w - b.w}; }
};
inline float Length(Vector3 value) { return std::sqrt(value.x * value.x + value.y * value.y + value.z * value.z); }
template <typename T> inline T AlignUp(T value, T alignment) { return (value + alignment - 1) / alignment * alignment; }
}
`;

const pchStub = `#pragma once
#include <algorithm>
#include <cassert>
#include <cfloat>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <limits>
#include <memory>
#include <numeric>
#include <span>
#include <stdexcept>
#include <tuple>
#include <unordered_map>
#include <utility>
#include <vector>
namespace PSOFlags { enum : std::uint16_t { kHasPosition = 0x001, kHasNormal = 0x002, kHasTangent = 0x004, kHasUV0 = 0x008 }; }
inline float F16ToF32(std::uint32_t bits) {
  const std::uint32_t sign = (bits >> 15) & 1u, exponent = (bits >> 10) & 0x1fu, mantissa = bits & 0x3ffu;
  if (exponent == 0) return std::ldexp(static_cast<float>(mantissa), -24) * (sign ? -1.0f : 1.0f);
  if (exponent == 31) return mantissa ? std::numeric_limits<float>::quiet_NaN() : (sign ? -INFINITY : INFINITY);
  return std::ldexp(1.0f + static_cast<float>(mantissa) / 1024.0f, static_cast<int>(exponent) - 15) * (sign ? -1.0f : 1.0f);
}
#define ASSERT(condition, ...) do { if (!(condition)) throw std::runtime_error("Nyx reference assertion failed"); } while (0)
`;

const utilityStub = `#pragma once
#include <cstdarg>
#include <cwchar>
namespace Utility { inline void Printf(const wchar_t*, ...) {} inline void Printf(const char*, ...) {} }
`;

const spanStub = `#pragma once
#include <cstddef>
#include <type_traits>
#include <vector>
namespace std {
template <typename T>
class span {
public:
  using element_type = T;
  using value_type = typename std::remove_cv<T>::type;
  using pointer = T*;
  using reference = T&;
  using iterator = pointer;
  span() noexcept : data_(nullptr), size_(0) {}
  span(pointer data, std::size_t size) noexcept : data_(data), size_(size) {}
  template <typename U, typename Alloc>
  span(std::vector<U, Alloc>& values) noexcept : data_(values.data()), size_(values.size()) {}
  template <typename U, typename Alloc>
  span(const std::vector<U, Alloc>& values) noexcept : data_(values.data()), size_(values.size()) {}
  pointer data() const noexcept { return data_; }
  std::size_t size() const noexcept { return size_; }
  iterator begin() const noexcept { return data_; }
  iterator end() const noexcept { return data_ + size_; }
  reference operator[](std::size_t index) const noexcept { return data_[index]; }
private:
  pointer data_;
  std::size_t size_;
};
}
`;

const modelStub = `#pragma once
`;

const executionStub = `#pragma once
#ifndef OENGINE_NYX_EXECUTION_STUB
#define OENGINE_NYX_EXECUTION_STUB
namespace std::execution { struct sequenced_policy {}; inline constexpr sequenced_policy seq{}; }
namespace std { template <typename It, typename Fn> It for_each(execution::sequenced_policy, It first, It last, Fn fn) { for (; first != last; ++first) fn(*first); return first; } }
#endif
`;

async function run(command, args, cwd, capture = false) {
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, windowsHide: true, stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit" });
    let stdout = "", stderr = "";
    child.stdout?.on("data", chunk => { stdout += chunk; });
    child.stderr?.on("data", chunk => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", code => code === 0 ? resolvePromise({ stdout: String(stdout), stderr: String(stderr) }) : reject(new Error(`${command} exited ${code}\n${stderr}`)));
  });
}

const work = await mkdtemp(join(tmpdir(), "oengine-nyx-reference-"));
try {
  const modelDir = join(work, "Model");
  const coreMathDir = join(work, "Core", "Math");
  const coreDir = join(work, "Core");
  await (await import("node:fs/promises")).mkdir(modelDir, { recursive: true });
  await (await import("node:fs/promises")).mkdir(coreMathDir, { recursive: true });
  await copyFile(join(sourceRoot, "MeshletBuilder.cpp"), join(modelDir, "MeshletBuilder.cpp"));
  await copyFile(join(sourceRoot, "MeshletBuilder.h"), join(modelDir, "MeshletBuilder.h"));
  await copyFile(join(sourceRoot, "MeshletStructs.h"), join(modelDir, "MeshletStructs.h"));
  await writeFile(join(modelDir, "pch.h"), pchStub);
  await writeFile(join(coreMathDir, "Vector.h"), vectorStub);
  await writeFile(join(coreDir, "Utility.h"), utilityStub);
  await writeFile(join(modelDir, "span"), spanStub);
  await writeFile(join(modelDir, "execution"), executionStub);
  await writeFile(join(modelDir, "Model.h"), modelStub);

  const optimizerSources = ["allocator.cpp", "clusterizer.cpp", "indexanalyzer.cpp", "indexcodec.cpp", "indexgenerator.cpp", "overdrawoptimizer.cpp", "partition.cpp", "quantization.cpp", "rasterizer.cpp", "simplifier.cpp", "spatialorder.cpp", "stripifier.cpp", "vcacheoptimizer.cpp", "vertexcodec.cpp", "vertexfilter.cpp", "vfetchoptimizer.cpp"].map(name => join(meshoptimizerRoot, name));
  const executable = join(work, process.platform === "win32" ? "nyx-reference.exe" : "nyx-reference");
  const standard = process.platform === "win32" && compiler.toLowerCase().includes("mingw") ? "c++2a" : "c++20";
  await run(compiler, [`-std=${standard}`, "-O2", "-fno-fast-math", "-ffp-contract=off", "-DNOMINMAX", `-I${modelDir}`, `-I${coreDir}`, `-I${meshoptimizerRoot}`, join(modelDir, "MeshletBuilder.cpp"), driver, ...optimizerSources, "-o", executable], repoDir);
  const result = await run(executable, [], repoDir, true);
  process.stdout.write(result.stdout);
} finally {
  await rm(work, { recursive: true, force: true });
}
