import type { Meta, StoryObj } from "@storybook/react-vite";
import React from "react";

function LibraryIntroduction() {
  return (
    <main className="oe-library-home">
      <p className="oe-example-eyebrow">GPU-first rendering engine</p>
      <h1>OEngine Examples</h1>
      <p>
        这里既是面向使用者的场景示例库，也是 WebGPU 主链的可运行证据入口。
        从“基础示例”开始，再按场景、可见性、着色、时域与 Benchmark 逐层深入。
      </p>
      <section className="oe-library-grid" aria-label="Example library sections">
        <article className="oe-library-card">
          <span>01 · Learn</span>
          <h2>基础示例</h2>
          <p>空场景、基础几何体和相机控制，直接运行真实 OEngine Renderer。</p>
        </article>
        <article className="oe-library-card">
          <span>02 · Explore</span>
          <h2>渲染能力</h2>
          <p>Packed Scene、Hierarchy、Visibility、Lighting 与 Temporal 调试入口。</p>
        </article>
        <article className="oe-library-card">
          <span>03 · Verify</span>
          <h2>基准与诊断</h2>
          <p>固定配方、Counters、GPU timestamp 和 feature-off contract。</p>
        </article>
      </section>
    </main>
  );
}

const meta = {
  title: "开始使用/示例库导览",
  component: LibraryIntroduction,
  parameters: {
    controls: { disable: true }
  }
} satisfies Meta<typeof LibraryIntroduction>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Overview: Story = {
  name: "OEngine Examples"
};
