export interface ExampleCatalogEntry {
  readonly id: string;
  readonly title: string;
  readonly route: string;
}

export const exampleCatalog = {
  basicScene: {
    id: "Showcase 01",
    title: "Basic Scene · Cube + Plane",
    route: "basic-scene/"
  },
  renderingLab: {
    id: "Showcase 00",
    title: "Rendering Lab · Integrated Quality Fixture",
    route: "rendering-lab/"
  },
  modelLoading: {
    id: "Feature 02",
    title: "Model Loading · Packed glTF",
    route: "model-loading/"
  },
  geometryPreprocess: {
    id: "Feature 03",
    title: "Geometry Preprocess · Cook + Reopen",
    route: "geometry-preprocess/"
  }
} as const satisfies Record<string, ExampleCatalogEntry>;
