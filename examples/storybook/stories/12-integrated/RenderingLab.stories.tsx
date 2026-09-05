import type { Meta, StoryObj } from "@storybook/react-vite";
import { exampleCatalog } from "../../catalog";
import { CatalogExample } from "../../components/EngineExamplePage";

const meta = {
  title: "12 Integrated/01 Rendering Lab",
  component: CatalogExample,
  parameters: { controls: { disable: true } }
} satisfies Meta<typeof CatalogExample>;

export default meta;
type Story = StoryObj<typeof meta>;

export const RenderingLab: Story = {
  name: "Rendering Lab",
  args: { entry: exampleCatalog.renderingLab }
};
