/**
 * index：提供渲染器共享的基础数据结构与通用工具。
 */

export { Signal, ChangeSignal } from "./Signal.js";
export type { SignalHandler } from "./Signal.js";
export { Color } from "./Color.js";
export { Sampler2D } from "../texture/Sampler2D.js";
export {
  hashFloat,
  hashMix,
  hashU32Range,
  hashOptional,
  hashArrayBuffer,
  arrayBufferEquals
} from "./hashMix.js";
export {
  arrayShallowEquals,
  isTypedArray,
  arrayRemoveFirst,
  arrayHashFloats,
  isInstanceOf,
  isInstanceOfCtor
} from "./arrayUtils.js";
export { assert, assertIsOneOf, Assert, _ } from "./assert.js";
export {
  copyArrayRange,
  bufferCopyStride,
  copyArrayBufferRange,
  copyTypedArrayContents,
  max3,
  detectNativeEndianness,
  countTrailingZeros32,
  nextPowerOfTwo,
  isPowerOfTwo,
  equalsViaMethod,
  hashMapSlot,
  trailingZeroIndex32,
  popcount32,
  hashViaMethod,
  hashString,
  stringApproxByteSize,
  alignCeil,
  aabbFromPositions
} from "./memoryUtils.js";
export { HashMap, HashMapEntry } from "./HashMap.js";
export type {
  KeyHashFunction,
  KeyEqualityFunction,
  HashMapOptions
} from "./HashMap.js";
export { HashSet, Wo } from "./HashSet.js";
export type { HashSetOptions } from "./HashSet.js";
export { deepHash, deepEquals, Zo, e_ } from "./deepHashEquals.js";
export { BitSet } from "./BitSet.js";
export {
  WeightedCache,
  CacheElement,
  weightOne,
  weightZero
} from "./WeightedCache.js";
export type { WeightedCacheOptions } from "./WeightedCache.js";
export {
  TableSpec,
  StructuredTable,
  FunctionCompiler,
  CompiledFunctionKey,
  tableSpecCache,
  sizeOfDataType,
  enumKeyOf,
  compileCellReader,
  compileCellWriter,
  DATA_TYPE_BYTE_SIZE,
  DATA_VIEW_GETTERS,
  DATA_VIEW_SETTERS
} from "./TableSpec.js";
export type {
  CellReader,
  CellWriter,
  RowReader,
  RowWriter
} from "./TableSpec.js";
export {
  WebGPUType,
  PrimitiveType,
  AtomicType,
  ArrayType,
  CodeChunk,
  pushUnique,
  PRIMITIVE_BY_TAG,
  WGSL_EXT_SUBGROUPS,
  WGSL_EXT_TEXTURE_FORMATS_TIER1,
  WGSL_bool,
  WGSL_i32,
  WGSL_u32,
  WGSL_f32,
  WGSL_f16,
  WGSL_vec2f,
  WGSL_vec3f,
  WGSL_vec4f,
  WGSL_mat4x4f,
  WGSL_atomic_u32,
  WGSL_atomic_i32
} from "./WebGPUTypes.js";
export { Line, LineBuilder } from "./LineBuilder.js";
export {
  StructType,
  WgslStructField,
  WgslAttribute,
  parseWgslType,
  findAlignedClearRange,
  nextStructName,
  resetStructNameSeq,
  STRUCT_PACK_ALIGN,
  ATTR_ALIGN
} from "./WgslStruct.js";
export {
  readWgslValue,
  writeWgslValue,
  writeWgslToBuffer,
  readFloat32N,
  readInt32N,
  readUint32N,
  wgslScratchReader
} from "./WgslBufferIO.js";
export { Vec2 } from "./math/Vec2.js";
export { Vec3 } from "./math/Vec3.js";
export { Quat } from "./math/Quat.js";
export { Transform3D, TransformFlag } from "./math/Transform3D.js";
export {
  clamp,
  clamp01,
  roughlyEqual,
  lerp,
  DEG2RAD,
  MATH_EPS,
  TWO_PI,
  hypot4,
  sign,
  distance3,
  lengthSquared3,
  lerpVec3,
  length3,
  dot3,
  inverseLerp,
  writeNormalizedPlane4,
  hashArrayItems,
  arrayDeepEquals,
  fmax,
  fmin,
  lengthSquared2,
  hypot2,
  nowSeconds,
  deepOrRefEquals
} from "./math/mathUtils.js";
export { base64Encode, base64Decode, Base64Codec, ir } from "./base64Codec.js";
export {
  mat4Identity,
  mat4Copy,
  mat4Multiply,
  mat4Perspective,
  mat4PerspectiveInfiniteReverseZ,
  mat4ViewFromWorldTransform,
  mat4ExtractFrustumPlanes,
  mat4LookAt,
  mat4FromTranslationScale,
  mat4FromTRS,
  mat4ApplyDirection,
  mat4TransformAABB,
  mat4TransformPoint,
  mat4MaxColumnScale,
  mat4Transpose,
  mat4Scale,
  mat4RotateX,
  mat4RotateY,
  mat4RotateZ,
  mat4Ortho,
  mat4Create,
  mat4Clone,
  mat4Translate,
  vec3Create,
  vec3FromValues,
  vec3Copy,
  vec3Set,
  vec3Min,
  vec3Max,
  vec3TransformMat4,
  quatCreate,
  aabbExtentLength,
  aabbToBoundingSphere
} from "./math/Mat4.js";
export {
  AABB2,
  intervalOverlaps1D,
  aabb2Overlaps,
  lineSegmentIntersect2D
} from "./math/AABB2.js";
