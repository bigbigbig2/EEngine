import type { Meta, StoryObj } from "@storybook/react-vite";
import React from "react";
import { OEngineCanvas, type OEngineCanvasProps } from "../components/OEngineCanvas";

function BasicExample(args: OEngineCanvasProps) {
  return <OEngineCanvas {...args} />;
}

const meta = {
  title: "Basics",
  component: BasicExample,
  tags: ["autodocs"],
  args: {
    mode: "box",
    color: "#4287f5",
    interactiveCamera: false
  },
  argTypes: {
    mode: {
      control: "select",
      options: ["empty", "box", "grid"],
      description: "Scene preset"
    },
    color: {
      control: "color",
      description: "Standard material base color"
    },
    interactiveCamera: {
      control: "boolean",
      description: "Enable the orbital camera controller"
    }
  }
} satisfies Meta<typeof BasicExample>;

export default meta;
type Story = StoryObj<typeof meta>;

export const EmptyScene: Story = {
  name: "01 · Empty Scene",
  args: {
    mode: "empty",
    interactiveCamera: false
  }
};

export const BasicGeometry: Story = {
  name: "02 · Basic Geometry",
  args: {
    mode: "box",
    interactiveCamera: false
  }
};

export const CameraControls: Story = {
  name: "03 · Camera Controls",
  args: {
    mode: "grid",
    interactiveCamera: true
  }
};
