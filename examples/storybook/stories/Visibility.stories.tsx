import type { Meta, StoryObj } from "@storybook/react-vite";
import React from "react";
import { exampleCatalog, type ExampleCatalogEntry } from "../catalog";
import { CatalogExample } from "../components/EngineExamplePage";

const meta = {
  title: "Visibility",
  component: CatalogExample,
  tags: ["autodocs"],
  parameters: { controls: { disable: true } }
} satisfies Meta<typeof CatalogExample>;

export default meta;
type Story = StoryObj<typeof meta>;

export const HardwareVisibility: Story = {
  name: "Hardware Visibility",
  args: { entry: exampleCatalog.hardwareVisibility as ExampleCatalogEntry }
};
