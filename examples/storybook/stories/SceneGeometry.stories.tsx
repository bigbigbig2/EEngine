import type { Meta, StoryObj } from "@storybook/react-vite";
import React from "react";
import { exampleCatalog, type ExampleCatalogEntry } from "../catalog";
import { CatalogExample } from "../components/EngineExamplePage";

const meta = {
  title: "场景与几何",
  component: CatalogExample,
  tags: ["autodocs"],
  parameters: { controls: { disable: true } }
} satisfies Meta<typeof CatalogExample>;

export default meta;
type Story = StoryObj<typeof meta>;

export const PackedInstances: Story = {
  name: "Packed Instances",
  args: { entry: exampleCatalog.packedScene as ExampleCatalogEntry }
};

export const HierarchicalLod: Story = {
  name: "Hierarchical LOD",
  args: { entry: exampleCatalog.hierarchicalLod as ExampleCatalogEntry }
};
