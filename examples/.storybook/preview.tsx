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
        order: [
          "Getting Started",
          "Basics",
          "Scene & Geometry",
          "Visibility",
          "Lighting & Shading",
          "Temporal & Post",
          "Benchmarks & Diagnostics"
        ]
      }
    }
  }
};

export default preview;
