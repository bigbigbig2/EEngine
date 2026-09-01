import type { Meta, StoryObj } from "@storybook/react-vite";
import React from "react";
import { exampleCatalog, type ExampleCatalogEntry } from "../catalog";
import { CatalogExample } from "../components/EngineExamplePage";

const meta = {
  title: "基准与诊断",
  component: CatalogExample,
  parameters: { controls: { disable: true } }
} satisfies Meta<typeof CatalogExample>;

export default meta;
type Story = StoryObj<typeof meta>;

export const BenchmarkA: Story = {
  name: "Benchmark A · Teapot",
  args: { entry: exampleCatalog.benchmarkA as ExampleCatalogEntry }
};

export const BenchmarkB: Story = {
  name: "Benchmark B · Helmet",
  args: { entry: exampleCatalog.benchmarkB as ExampleCatalogEntry }
};

export const BenchmarkC: Story = {
  name: "Benchmark C · Generality",
  args: { entry: exampleCatalog.benchmarkC as ExampleCatalogEntry }
};
