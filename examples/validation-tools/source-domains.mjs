export const UNMAPPED_OENGINE_FALLBACK_CASES = Object.freeze([
  "smoke.basic",
  "lifecycle.init-destroy",
  "visibility.basic"
]);

const DOMAIN_RULES = Object.freeze([
  rule("validation-system", /^examples\/validation(?:-tools)?\//),
  rule("rendering-lab", /^examples\/rendering-lab\//),
  rule("documentation", /^(?:docs\/|CONTEXT-MAP\.md$|README\.md$|AGENTS\.md$|OEngine\/AGENTS\.md$)/),
  rule("public-interface", /^OEngine\/src\/index\.ts$/),
  rule("framegraph", /^OEngine\/src\/framegraph\//),
  rule("renderer", /^OEngine\/src\/render\/Renderer(?:Config)?\.ts$/),
  rule("graphics-context", /^OEngine\/src\/gpu\/GraphicsContext\.ts$/),
  rule("visibility", /^OEngine\/src\/(?:render\/(?:Hierarchical|Visibility|Triangle|passes\/.*(?:Visibility|HZB|Raster))|gpu\/GpuVisibility|shaders\/.*(?:visibility|hzb|raster))/i),
  rule("hzb", /^OEngine\/src\/(?:render\/HierarchicalZBuffer|render\/passes\/.*HZB|shaders\/.*hzb)/i),
  rule("gpu-scene", /^OEngine\/src\/gpu\/(?:GpuScene|GpuRenderWorld|GpuAssetStore|GpuSceneResidencyManifest)/),
  rule("asset", /^OEngine\/src\/(?:geometry|loaders)\//),
  rule("surface", /^OEngine\/src\/(?:render\/(?:features\/SurfaceFeature|passes\/.*(?:Material|Surface))|shaders\/.*(?:material|surface|shade))/i),
  rule("material", /^OEngine\/src\/(?:material|gpu\/GpuMaterialStore)/),
  rule("texture-residency", /^OEngine\/src\/(?:texture|gpu\/TextureResidency)/),
  rule("lifecycle", /^OEngine\/src\/render\/pipeline\/RenderSettings/),
  rule("observability", /^OEngine\/src\/(?:debug|addons\/inspector)\//),
  rule("build", /^(?:OEngine|examples)\/(?:package(?:-lock)?\.json|tsconfig.*\.json|vite\.config\.ts)$/)
]);

export function normalizeRepositoryPath(value) {
  return value.replaceAll("\\", "/").replace(/^\.\//, "");
}

export function domainsForPath(value) {
  const normalized = normalizeRepositoryPath(value);
  return DOMAIN_RULES
    .filter((entry) => entry.pattern.test(normalized))
    .map((entry) => entry.domain);
}

export function isUnmappedEngineSource(value, domains) {
  const normalized = normalizeRepositoryPath(value);
  return normalized.startsWith("OEngine/src/") && domains.length === 0;
}

function rule(domain, pattern) {
  return Object.freeze({ domain, pattern });
}
