/** World-space transport coverage, independent of camera visibility. The guard
 * must cover the entire finite query segment, not just its source surface. */
export interface GeometryQueryDomain {
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
}

/** Capture a conservative envelope of every cascade and its finite guard.
 * The envelope deliberately includes gaps between cascades: extra coverage is
 * safe, whereas clipping a ray to a cascade edge would fabricate a sky miss. */
export function geometryQueryDomain(
  cascades: readonly GeometryQueryDomain[],
  guard: number,
): GeometryQueryDomain {
  if (cascades.length === 0 || !Number.isFinite(guard) || guard < 0) {
    throw new RangeError("Query coverage requires cascades and a finite nonnegative guard");
  }
  const low: [number, number, number] = [Infinity, Infinity, Infinity];
  const high: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const cascade of cascades) {
    if (cascade.min.length !== 3 || cascade.max.length !== 3) {
      throw new RangeError("Query coverage bounds require three axes");
    }
    for (let axis = 0; axis < 3; axis++) {
      const min = cascade.min[axis]!;
      const max = cascade.max[axis]!;
      if (!Number.isFinite(min) || !Number.isFinite(max) || min > max) {
        throw new RangeError("Query coverage bounds are not finite and ordered");
      }
      // Round outward after conversion to the GPU's coordinate precision.
      low[axis] = Math.min(low[axis]!, outwardFloat32(min - guard, false));
      high[axis] = Math.max(high[axis]!, outwardFloat32(max + guard, true));
    }
  }
  return Object.freeze({ min: Object.freeze(low), max: Object.freeze(high) });
}

export function geometryQueryDomainWords(domain?: GeometryQueryDomain): Float32Array {
  const words = new Float32Array(8);
  if (domain !== undefined) {
    const captured = geometryQueryDomain([domain], 0);
    words.set(captured.min);
    words[3] = 1;
    words.set(captured.max, 4);
  }
  return words;
}

function outwardFloat32(value: number, upper: boolean): number {
  const floats = new Float32Array([value]);
  const rounded = floats[0]!;
  if (!Number.isFinite(rounded)) {
    throw new RangeError("Query coverage escapes finite GPU coordinates");
  }
  if (upper ? rounded < value : rounded > value) {
    const bits = new Uint32Array(floats.buffer);
    if (rounded === 0) {
      bits[0] = upper ? 1 : 0x80000001;
    } else {
      bits[0] = bits[0]! + ((rounded > 0) === upper ? 1 : -1);
    }
  }
  if (!Number.isFinite(floats[0]!)) {
    throw new RangeError("Query coverage outward rounding overflowed");
  }
  return floats[0]!;
}

/** Shared by the GPU certificate and instance view; singular/nonfinite bounds
 * remain relevant unknown geometry rather than being culled outside a domain. */
export const GEOMETRY_QUERY_DOMAIN_WGSL = /* wgsl */ `
struct QueryLocalDomain {
  low: vec3f,
  high: vec3f,
  scale: f32,
  full: bool,
}
fn query_finite3(value: vec3f) -> bool {
  return all((bitcast<vec3u>(value) & vec3u(0x7f800000u)) != vec3u(0x7f800000u));
}
// Shared producer/certificate math. Ill-conditioned transforms retain the
// entire asset; they never shrink coverage using an unstable inverse.
fn query_instance_local_domain(instance: OEngineInstanceRecord, low: vec4f, high: vec4f) -> QueryLocalDomain {
  let model = oengine_instance_current_object_to_world(instance);
  let scale = sqrt(dot(model[0].xyz, model[0].xyz) +
    dot(model[1].xyz, model[1].xyz) + dot(model[2].xyz, model[2].xyz));
  var result = QueryLocalDomain(instance.bounds_min.xyz, instance.bounds_max.xyz, scale, true);
  if (low.w == 0.0 || !query_finite3(vec3f(scale)) || scale == 0.0) {
    return result;
  }
  let a = model[0].xyz / scale;
  let b = model[1].xyz / scale;
  let c = model[2].xyz / scale;
  let r0 = cross(b, c);
  let r1 = cross(c, a);
  let r2 = cross(a, b);
  let determinant = dot(a, r0);
  if (!(abs(determinant) > 0.001)) {
    return result;
  }
  let inverse = transpose(mat3x3f(r0, r1, r2)) * ((1.0 / determinant) / scale);
  var local_low = vec3f(3.402823466e38);
  var local_high = vec3f(-3.402823466e38);
  var roundoff_scale = vec3f(0.0);
  for (var corner = 0u; corner < 8u; corner++) {
    let world = vec3f(select(low.x, high.x, (corner & 1u) != 0u),
      select(low.y, high.y, (corner & 2u) != 0u),
      select(low.z, high.z, (corner & 4u) != 0u));
    let point = inverse * (world - model[3].xyz);
    if (!query_finite3(point)) {
      return result;
    }
    let absolute_input = abs(world) + abs(model[3].xyz);
    roundoff_scale = max(roundoff_scale,
      abs(inverse[0]) * absolute_input.x + abs(inverse[1]) * absolute_input.y +
      abs(inverse[2]) * absolute_input.z);
    local_low = min(local_low, point);
    local_high = max(local_high, point);
  }
  // Deliberately wide forward-error envelope for normalization, cofactors,
  // determinant, inverse and corner products, including cancellation.
  let padding = max(vec3f(1.0), roundoff_scale) * (0.00006103515625 / abs(determinant));
  if (!query_finite3(padding)) {
    return result;
  }
  result.low = max(instance.bounds_min.xyz, local_low - padding);
  result.high = min(instance.bounds_max.xyz, local_high + padding);
  result.full = false;
  return result;
}
fn query_instance_in_domain(instance: OEngineInstanceRecord, low: vec4f, high: vec4f) -> bool {
  if (low.w == 0.0) {
    return true;
  }
  let model = oengine_instance_current_object_to_world(instance);
  var world_low = vec3f(3.402823466e38);
  var world_high = vec3f(-3.402823466e38);
  for (var corner = 0u; corner < 8u; corner++) {
    let point = vec3f(
      select(instance.bounds_min.x, instance.bounds_max.x, (corner & 1u) != 0u),
      select(instance.bounds_min.y, instance.bounds_max.y, (corner & 2u) != 0u),
      select(instance.bounds_min.z, instance.bounds_max.z, (corner & 4u) != 0u));
    let world = (model * vec4f(point, 1.0)).xyz;
    if (any((bitcast<vec3u>(world) & vec3u(0x7f800000u)) == vec3u(0x7f800000u))) {
      return true;
    }
    world_low = min(world_low, world);
    world_high = max(world_high, world);
  }
  return all(world_high >= low.xyz) && all(world_low <= high.xyz);
}
`;
