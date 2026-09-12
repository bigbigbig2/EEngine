import type { Preview } from "@storybook/react-vite";

const preview: Preview = {
  parameters: {
    layout: "centered",
    controls: {
      expanded: true,
      sort: "requiredFirst"
    }
  }
};

export default preview;
