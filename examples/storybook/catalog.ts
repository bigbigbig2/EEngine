export interface ExampleCatalogEntry {
  readonly id: string;
  readonly title: string;
  readonly route: string;
}

export const exampleCatalog = {
  renderingLab: {
    id: "Showcase 00",
    title: "Rendering Lab · Integrated Quality Fixture",
    route: "rendering-lab/"
  }
} as const satisfies Record<string, ExampleCatalogEntry>;
