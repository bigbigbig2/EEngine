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
          "开始使用",
          "基础示例",
          "场景与几何",
          "可见性",
          "光照与着色",
          "时域与后处理",
          "基准与诊断"
        ]
      }
    }
  }
};

export default preview;
