import type { Meta, StoryObj } from "@storybook/react-vite";
import { exampleCatalog } from "../../catalog";
import { CatalogExample } from "../../components/EngineExamplePage";

const meta = {
  title: "01 Geometry/90 Legacy Geometry Preprocess",
  component: CatalogExample,
  parameters: { controls: { disable: true } }
} satisfies Meta<typeof CatalogExample>;

export default meta;
type Story = StoryObj<typeof meta>;

export const LegacyPreprocess: Story = {
  name: "Legacy Geometry Preprocess",
  args: { entry: exampleCatalog.geometryPreprocess }
};
