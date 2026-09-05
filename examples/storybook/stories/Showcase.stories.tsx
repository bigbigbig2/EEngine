import type { Meta, StoryObj } from "@storybook/react-vite";
import React from "react";
import { exampleCatalog } from "../catalog";
import { CatalogExample } from "../components/EngineExamplePage";

const meta = {
  title: "Showcase",
  component: CatalogExample,
  tags: ["autodocs"],
  parameters: { controls: { disable: true } }
} satisfies Meta<typeof CatalogExample>;

export default meta;
type Story = StoryObj<typeof meta>;

export const RenderingLab: Story = {
  name: "Rendering Lab",
  args: { entry: exampleCatalog.renderingLab }
};

export const BasicScene: Story = {
  name: "Basic Scene · Cube + Plane",
  args: { entry: exampleCatalog.basicScene }
};

export const ModelLoading: Story = {
  name: "Feature 02 · Model Loading",
  args: { entry: exampleCatalog.modelLoading }
};

export const GeometryPreprocess: Story = {
  name: "Feature 03 · Geometry Preprocess",
  args: { entry: exampleCatalog.geometryPreprocess }
};
