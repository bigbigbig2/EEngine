/** Diagnostic-only source ablation, never imported by the production renderer.
 * DCE/occupancy and altered downstream color make differences NON-ADDITIVE.
 * Every expected seam is checked; source drift must fail, not silently run baseline.
 */
export const sensitivityModes = Object.freeze(["production", "geometry-only", "material-only", "no-ibl", "no-direct", "no-shared-setup", "no-worker-statistics"]);

function editFunction(source, name, edit) {
  const start = source.indexOf(`fn ${name}(`);
  if (start < 0 || source.indexOf(`fn ${name}(`, start + 1) >= 0) throw new Error(`Expected exactly one WGSL function ${name}`);
  const begin = source.indexOf("{", start);
  let depth = 1, end = begin + 1;
  while (depth && end < source.length) {
    if (source[end] === "{") depth++;
    if (source[end] === "}") depth--;
    end++;
  }
  if (depth) throw new Error(`Unbalanced WGSL function ${name}`);
  return source.slice(0, begin + 1) + edit(source.slice(begin + 1, end - 1)) + source.slice(end - 1);
}

function before(body, seam) {
  const at = body.indexOf(seam);
  if (at < 0 || body.indexOf(seam, at + 1) >= 0) throw new Error(`Expected exactly one diagnostic seam ${seam}`);
  return body.slice(0, at);
}

export function rewriteSurfaceWorker(source, mode, { hasLit = true, closureLighting = false, physicalEnvironment = true } = {}) {
  if (!sensitivityModes.includes(mode)) throw new Error(`Unknown Surface diagnostic mode ${mode}`);
  if (mode === "production") return source;
  // Explicit generator specializations: these consumers have no target work.
  if (mode === "geometry-only" && (!hasLit || closureLighting)) return source;
  if (["material-only", "no-ibl", "no-direct"].includes(mode) && !hasLit) return source;
  if (mode === "no-ibl" && !physicalEnvironment) return source;
  if (mode === "geometry-only") {
    return editFunction(source, "sparse_evaluate_geometry", body => before(body, "let gradient_valid=bary.valid;") + `
      // Encode geometric attributes in the output so the compiler keeps restoration work.
      return OEngineSparseSurface(abs(normal)*0.5+fract(abs(position))*0.25+color*0.25,
        1.0,normal,0.5,geometric,0.0,vec3f(0.0),1.0,position,vec2f(0.0),
        textureLoad(visibility_depth,vec2i(pixel),0),OENGINE_SURFACE_FLAG_VALID|OENGINE_SURFACE_FLAG_UNLIT,
        1.0,vec3f(1.0),1.5,0.0,0.0,normal);
    `);
  }
  if (mode === "material-only") return editFunction(source, "sparse_direct", () => `
    return surface.base_color+surface.emissive+vec3f(surface.roughness,surface.metallic,surface.material_ao)*0.01+
      abs(surface.shading_normal)*0.01+surface.specular_color*0.01+vec3f(surface.specular_weight+surface.ior)*0.001+
      abs(surface.coat_normal)*surface.coat_factor*0.01+vec3f(surface.coat_roughness)*0.001;
  `);
  if (mode === "no-ibl") return editFunction(source, "sparse_direct", body => before(body, "let sky_irradiance =") + "return direct+physical_sun+surface.emissive;\n");
  if (mode === "no-direct") return editFunction(source, "sparse_direct", body => {
    const begin = body.indexOf("let direct = shade_standard_material_direct(");
    const end = body.indexOf(");", begin);
    if (begin < 0 || end < 0 || (physicalEnvironment && !body.includes("let physical_sun = sun_reflected.diffuse + sun_reflected.specular;"))) throw new Error("Missing direct-light diagnostic seams");
    return (body.slice(0, begin) + "let direct=vec3f(0.0);" + body.slice(end + 2))
      .replace("let physical_sun = sun_reflected.diffuse + sun_reflected.specular;", "let physical_sun=vec3f(0.0);");
  });
  if (mode === "no-shared-setup") {
    source = editFunction(source, "surface_setup_prepare", () => "\n");
    return editFunction(source, "surface_setup_for_work", () => "return surface_setup_direct(item,primitive);\n");
  }
  let count = 0;
  source = source.replace(/sample_add\(SAMPLE_COUNTER_(?:material|lighting|full|coarse|materialCoarse|lightingCoarse|setupBuilds|setupHits|setupMisses|splitPixels),1u\);/g, () => { count++; return ""; });
  if (count < 5) throw new Error("Missing worker statistics diagnostic seams");
  return source;
}
