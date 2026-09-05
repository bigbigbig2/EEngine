import type { Meta, StoryObj } from "@storybook/react-vite";
import { exampleCatalog } from "../../catalog";
import { CatalogExample } from "../../components/EngineExamplePage";

const meta = {
  title: "00 Foundations/02 Pure Model Loading",
  component: CatalogExample,
  parameters: { controls: { disable: true } }
} satisfies Meta<typeof CatalogExample>;

export default meta;
type Story = StoryObj<typeof meta>;

export const PureModelLoading: Story = {
  name: "Pure Model Loading",
  args: { entry: exampleCatalog.modelLoading }
};
