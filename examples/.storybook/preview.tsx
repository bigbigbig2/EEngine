import type { Preview } from "@storybook/react-vite";
import React from "react";
import "../storybook/styles/storybook.css";

const preview: Preview = {
  decorators: [
    (Story) => (
      <div className="oe-story-root">
        <Story />
      </div>
    )
  ],
  parameters: {
    layout: "fullscreen",
    controls: {
      expanded: true,
      sort: "requiredFirst"
    },
    options: {
      storySort: {
        order: ["Showcase"]
      }
    }
  }
};

export default preview;
