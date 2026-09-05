import type { Meta, StoryObj } from "@storybook/react-vite";
import { exampleCatalog } from "../../catalog";
import { CatalogExample } from "../../components/EngineExamplePage";

const meta = {
  title: "00 Foundations/01 Pure Geometry",
  component: CatalogExample,
  parameters: { controls: { disable: true } }
} satisfies Meta<typeof CatalogExample>;

export default meta;
type Story = StoryObj<typeof meta>;

export const PureGeometry: Story = {
  name: "Pure Geometry",
  args: { entry: exampleCatalog.basicScene }
};
