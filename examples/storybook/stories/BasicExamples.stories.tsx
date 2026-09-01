import type { Meta, StoryObj } from "@storybook/react-vite";
import React from "react";
import { EngineExamplePage } from "../components/EngineExamplePage";
import { OEngineCanvas, type OEngineCanvasProps } from "../components/OEngineCanvas";

function BasicExample(args: OEngineCanvasProps) {
  const metadata = basicExampleMetadata(args.mode, args.interactiveCamera);
  return (
    <EngineExamplePage
      eyebrow={metadata.eyebrow}
      title={metadata.title}
      description={metadata.description}
      status="Validation"
      tags={metadata.tags}
      stats={metadata.stats}
      sourcePath="examples/storybook/stories/BasicExamples.stories.tsx"
      footer={<span>Story 卸载时会停止帧循环、输入监听并释放 Renderer 资源。</span>}
    >
      <OEngineCanvas {...args} />
    </EngineExamplePage>
  );
}

const meta = {
  title: "基础示例",
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
      description: "基础场景配方"
    },
    color: {
      control: "color",
      description: "StandardShadeMaterial 基础色"
    },
    interactiveCamera: {
      control: "boolean",
      description: "启用 OrbitalCameraController"
    }
  }
} satisfies Meta<typeof BasicExample>;

export default meta;
type Story = StoryObj<typeof meta>;

export const EmptyScene: Story = {
  name: "01 · 空场景",
  args: {
    mode: "empty",
    interactiveCamera: false
  }
};

export const BasicGeometry: Story = {
  name: "02 · 基础几何体",
  args: {
    mode: "box",
    interactiveCamera: false
  }
};

export const CameraControls: Story = {
  name: "03 · 相机控制",
  args: {
    mode: "grid",
    interactiveCamera: true
  }
};

function basicExampleMetadata(mode: OEngineCanvasProps["mode"], interactive: boolean) {
  if (mode === "empty") {
    return {
      eyebrow: "Basic 01",
      title: "Empty Renderer",
      description: "最小 Renderer / Scene / PerspectiveCamera 生命周期，只保留统一主管线的必要工作。",
      tags: ["Renderer", "Scene", "Lifecycle"],
      stats: [["Geometry", "0"], ["Camera", "Perspective"], ["Feature set", "Minimal"]] as const
    };
  }
  if (interactive) {
    return {
      eyebrow: "Basic 03",
      title: "Camera Controls",
      description: "真实 7×7 Box 场景与 OrbitalCameraController；支持旋转、平移和缩放。",
      tags: ["Camera", "Input", "Frame loop"],
      stats: [["Instances", "49"], ["Controller", "Orbital"], ["Resize", "Observed"]] as const
    };
  }
  return {
    eyebrow: "Basic 02",
    title: "Basic Geometry",
    description: "BoxGeometry、StandardShadeMaterial、DirectionalLight 与实时 OEngine Renderer 的最小组合。",
    tags: ["Geometry", "Material", "Lighting"],
    stats: [["Instances", "1"], ["Material", "Standard"], ["Light", "Directional"]] as const
  };
}
