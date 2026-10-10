// The upstream scalar port assumes MSVC's global float overloads. MinGW exposes
// them in std; match the float math used by the Emscripten build without changing
// the codec or using a lower-quality encoder.
#include <cmath>
#include <cinttypes>
using std::floor;
using std::sqrt;
