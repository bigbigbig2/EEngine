const chromeWebGpu = Object.freeze({ localChrome: true, webgpu: true });

export const VALIDATION_CASES = Object.freeze([
  defineCase("smoke.basic", "smoke", "basic", ["smoke", "renderer", "graphics-context", "gpu-scene"], ["validation-system", "rendering-lab", "public-interface", "framegraph", "renderer", "graphics-context", "gpu-scene", "asset", "observability", "build"], "always"),
  defineCase("smoke.scene-adapter", "smoke", "scene-adapter", ["smoke", "renderer", "graphics-context", "gpu-scene", "scene-adapter"], ["gpu-scene", "scene"]),
  defineCase("smoke.scene-resync", "smoke", "scene-resync", ["smoke", "renderer", "gpu-scene", "scene-adapter", "lifecycle"], ["gpu-scene", "scene", "lifecycle"]),
  defineCase("lifecycle.init-destroy", "lifecycle", "init-destroy", ["lifecycle", "renderer", "graphics-context", "gpu-resource"], ["validation-system", "public-interface", "framegraph", "renderer", "graphics-context", "lifecycle", "build"]),
  defineCase("lifecycle.resize", "lifecycle", "resize", ["lifecycle", "renderer", "graphics-context"], ["lifecycle"]),
  defineCase("lifecycle.recreate-renderer", "lifecycle", "recreate-renderer", ["lifecycle", "renderer", "graphics-context", "gpu-resource"]),
  defineCase("lifecycle.device-loss-recreate", "lifecycle", "device-loss-recreate", ["lifecycle", "renderer", "graphics-context", "gpu-resource", "shadow"], ["graphics-context", "lifecycle", "shadow"]),
  defineCase("lifecycle.replace-scene", "lifecycle", "replace-scene", ["lifecycle", "renderer", "gpu-scene", "gpu-resource"], ["gpu-scene"]),
  defineCase("lifecycle.release-reregister", "lifecycle", "release-reregister", ["lifecycle", "renderer", "gpu-scene", "gpu-resource"], ["gpu-scene"]),
  defineCase("visibility.basic", "visibility", "basic", ["visibility", "gpu-driven", "hierarchy", "raster"], ["framegraph", "renderer", "graphics-context", "visibility"]),
  defineCase("visibility.meshlet-work-overflow", "visibility", "meshlet-work-overflow", ["visibility", "gpu-driven", "hierarchy", "gpu-abi"], ["visibility"]),
  defineCase("visibility.meshlet-work-portable", "visibility", "meshlet-work-portable", ["visibility", "gpu-driven", "hierarchy", "gpu-abi"], ["visibility"]),
  defineCase("visibility.shadow", "visibility", "shadow", ["visibility", "gpu-driven", "shadow", "material"], ["renderer", "graphics-context", "visibility", "shadow", "material"]),
  defineCase("visibility.shadow-toggle", "visibility", "shadow-toggle", ["visibility", "gpu-driven", "shadow", "lifecycle"], ["shadow", "lifecycle"]),
  defineCase("visibility.shadow-scene-parity", "visibility", "shadow-scene-parity", ["visibility", "shadow", "scene-adapter"], ["shadow", "gpu-scene", "scene"]),
  defineCase("visibility.frustum", "visibility", "frustum", ["visibility", "gpu-driven", "frustum"]),
  defineCase("visibility.occlusion", "visibility", "occlusion", ["visibility", "gpu-driven", "hzb"], ["visibility", "hzb"]),
  defineCase("visibility.lod-near", "visibility", "lod-near", ["visibility", "gpu-driven", "hierarchy", "lod"]),
  defineCase("visibility.lod-far", "visibility", "lod-far", ["visibility", "gpu-driven", "hierarchy", "lod"]),
  defineCase("visibility.camera-cut", "visibility", "camera-cut", ["visibility", "gpu-driven", "hzb", "temporal"], ["hzb"]),
  defineCase("visibility.debug", "visibility", "debug", ["visibility", "renderer", "framegraph", "debug"], ["framegraph", "renderer"]),
  defineCase("visibility.transform-patch", "visibility", "transform-patch", ["visibility", "gpu-driven", "gpu-scene"], ["gpu-scene"]),
  defineCase("surface.basic", "surface", "basic", ["surface", "material-resolve"], ["surface", "material"], "always"),
  defineCase("surface.textured", "surface", "textured", ["surface", "material", "texture-residency"], ["surface", "texture-residency"], "always"),
  defineCase("surface.material-switch", "surface", "material-switch", ["surface", "material", "gpu-scene"], ["material"]),
  defineCase("surface.texture-fallback", "surface", "texture-fallback", ["surface", "material", "texture-residency"], ["texture-residency"]),
  defineCase("surface.texture-ref-oracle", "surface", "texture-ref-oracle", ["surface", "material", "texture-residency", "gpu-abi"], ["texture-residency"]),
  defineCase("surface.texture-package-bc", "surface", "texture-package-bc", ["surface", "asset", "texture-package", "texture-residency"], ["texture-package"], "always"),
  defineCase("surface.transparent", "surface", "transparent", ["surface", "material", "transparency"], ["renderer", "graphics-context", "surface", "material", "transparency"]),
  defineCase("surface.scene-adapter", "surface", "scene-adapter", ["surface", "material", "transparency", "temporal", "scene-adapter"], ["renderer", "gpu-scene", "scene", "surface", "material", "transparency", "temporal"])
]);

const CASE_BY_ID = new Map(VALIDATION_CASES.map((entry) => [entry.id, entry]));

export function validationCase(caseId) {
  const entry = CASE_BY_ID.get(caseId);
  if (entry === undefined) throw new Error(`Unknown validation case '${caseId}'`);
  return entry;
}

export function casesForDomain(domain) {
  return VALIDATION_CASES.filter((entry) => entry.domains.includes(domain));
}

export function casesForFixture(fixture) {
  return VALIDATION_CASES.filter((entry) => entry.fixture === fixture);
}

export function isValidationCaseId(value) {
  return CASE_BY_ID.has(value);
}

function defineCase(id, fixture, scenario, domains, changedDomains = [], screenshot = "on-failure") {
  return Object.freeze({
    id,
    fixture,
    route: `/validation/${fixture}/`,
    scenario,
    domains: Object.freeze([...domains]),
    changedDomains: Object.freeze([...changedDomains]),
    requirements: chromeWebGpu,
    screenshot,
    timeoutMs: 30_000
  });
}
