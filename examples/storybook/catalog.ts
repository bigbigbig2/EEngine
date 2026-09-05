export interface ExampleCatalogEntry {
  readonly id: string;
  readonly title: string;
  readonly route: string;
}

export const exampleCatalog = {
  basicScene: {
    id: "Foundation 01",
    title: "Pure Geometry · Cube + Plane",
    route: "runtime/00-foundations/pure-geometry/"
  },
  directionalLight: {
    id: "Foundation 04",
    title: "Directional Light · Direct Lighting",
    route: "runtime/00-foundations/directional-light/"
  },
  baseColorSanity: {
    id: "Foundation 05",
    title: "BaseColor Sanity · Known Colors",
    route: "runtime/00-foundations/base-color-sanity/"
  },
  sourceGeometry: {
    id: "Geometry 01",
    title: "Source Geometry · Vertices + Bounds",
    route: "runtime/01-geometry/source-geometry/"
  },
  vertexAttributes: {
    id: "Geometry 02",
    title: "Vertex Attributes · Position + Normal + UV",
    route: "runtime/01-geometry/vertex-attributes/"
  },
  meshletPartition: {
    id: "Geometry 03",
    title: "Meshlet Partition · ID + Counts",
    route: "runtime/01-geometry/meshlet-partition/"
  },
  meshletBounds: {
    id: "Geometry 04",
    title: "Meshlet Bounds · AABB + Sphere",
    route: "runtime/01-geometry/meshlet-bounds/"
  },
  meshletCone: {
    id: "Geometry 05",
    title: "Meshlet Cone · Axis + Cutoff",
    route: "runtime/01-geometry/meshlet-cone/"
  },
  clusterBuild: {
    id: "Geometry 06",
    title: "Cluster Build · Parent + Child Ranges",
    route: "runtime/01-geometry/cluster-build/"
  },
  clusterHierarchy: {
    id: "Geometry 07",
    title: "Cluster Hierarchy · Depth + Links",
    route: "runtime/01-geometry/cluster-hierarchy/"
  },
  sseLodSelection: {
    id: "Geometry 08",
    title: "SSE / LOD Selection · Screen Error",
    route: "runtime/01-geometry/sse-lod-selection/"
  },
  minimalScene: {
    id: "Foundation 03",
    title: "Renderer Baseline · Minimal Scene",
    route: "minimal-scene/"
  },
  renderingLab: {
    id: "Integrated 01",
    title: "Rendering Lab · Integrated Quality Fixture",
    route: "rendering-lab/"
  },
  modelLoading: {
    id: "Foundation 02",
    title: "Pure Model Loading · Packed glTF",
    route: "model-loading/"
  },
  geometryPreprocess: {
    id: "Geometry 90",
    title: "Legacy Geometry Preprocess · Cook + Reopen",
    route: "geometry-preprocess/"
  }
} as const satisfies Record<string, ExampleCatalogEntry>;
