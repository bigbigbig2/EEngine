import type { StorybookConfig } from "@storybook/react-vite";

const config: StorybookConfig = {
  stories: ["../storybook/**/*.stories.@(ts|tsx)"],
  staticDirs: [{ from: "../dist", to: "/runtime" }],
  addons: ["@storybook/addon-docs"],
  framework: {
    name: "@storybook/react-vite",
    options: {}
  },
  docs: {
    defaultName: "文档"
  }
};

export default config;
