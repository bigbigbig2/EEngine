import type { Meta, StoryObj } from "@storybook/react-vite";
import { exampleCatalog } from "../../catalog";
import { CatalogExample } from "../../components/EngineExamplePage";

const meta = {
  title: "01 Geometry/05 Meshlet Cone",
  component: CatalogExample,
  parameters: { controls: { disable: true } }
} satisfies Meta<typeof CatalogExample>;

export default meta;
type Story = StoryObj<typeof meta>;

export const MeshletCone: Story = {
  name: "Meshlet Cone",
  args: { entry: exampleCatalog.meshletCone }
};
