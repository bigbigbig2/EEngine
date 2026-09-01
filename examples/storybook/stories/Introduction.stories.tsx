import type { Meta, StoryObj } from "@storybook/react-vite";
import React from "react";

function LibraryIntroduction() {
  return (
    <main className="oe-library-home">
      <p className="oe-example-eyebrow">GPU-first rendering engine</p>
      <h1>OEngine Examples</h1>
      <p>
        A focused example library for learning OEngine and validating its WebGPU rendering path.
        Start with the basics, then explore scene data, visibility, shading, temporal rendering,
        benchmarks, and diagnostics.
      </p>
      <section className="oe-library-grid" aria-label="Example library sections">
        <article className="oe-library-card">
          <span>01 · Learn</span>
          <h2>Basics</h2>
          <p>Empty scenes, basic geometry, and camera controls running on the real OEngine renderer.</p>
        </article>
        <article className="oe-library-card">
          <span>02 · Explore</span>
          <h2>Rendering Features</h2>
          <p>Packed scenes, hierarchy, visibility, lighting, and temporal rendering examples.</p>
        </article>
        <article className="oe-library-card">
          <span>03 · Verify</span>
          <h2>Benchmarks & Diagnostics</h2>
          <p>Fixed workloads, counters, GPU timestamps, and feature-off contracts.</p>
        </article>
      </section>
    </main>
  );
}

const meta = {
  title: "Getting Started/Overview",
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
