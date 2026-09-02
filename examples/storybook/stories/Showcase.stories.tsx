import type { Meta, StoryObj } from "@storybook/react-vite";
import React from "react";
import { exampleCatalog, type ExampleCatalogEntry } from "../catalog";
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
  args: { entry: exampleCatalog.renderingLab as ExampleCatalogEntry }
};

export const RenderingLabGpuPipeline: Story = {
  name: "Rendering Lab · GPU Pipeline",
  args: { entry: exampleCatalog.renderingLabPipeline as ExampleCatalogEntry }
};

export const CyberpunkCity: Story = {
  name: "Cyberpunk City",
  args: { entry: exampleCatalog.integratedShowcase as ExampleCatalogEntry }
};
