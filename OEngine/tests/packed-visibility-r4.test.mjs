import test from "node:test";
import assert from "node:assert/strict";

globalThis.GPUShaderStage ??= { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 };
globalThis.GPUTextureUsage ??= {
  COPY_SRC: 1 << 0,
  TEXTURE_BINDING: 1 << 2,
  RENDER_ATTACHMENT: 1 << 4
};

const { FrameGraph } = await import("../.test-dist/framegraph/FrameGraph.js");
const {
  PACKED_VISIBILITY_FRAGMENT_EVIDENCE,
  PackedVisibilityPass,
  packedVisibilityAttachmentDescriptor
} = await import("../.test-dist/render/passes/PackedVisibilityPass.js");

test("R4-A-02 VisibilityKey attachment freezes format, usage and dimensions", () => {
  const descriptor = packedVisibilityAttachmentDescriptor(1280, 720);
  assert.deepEqual(descriptor, {
    kind: "transient_texture",
    label: "R4 VisibilityKey v1 r32uint",
    width: 1280,
    height: 720,
    format: "r32uint",
    usage:
      GPUTextureUsage.RENDER_ATTACHMENT |
      GPUTextureUsage.TEXTURE_BINDING |
      GPUTextureUsage.COPY_SRC
  });
  assert.throws(() => packedVisibilityAttachmentDescriptor(0, 1), /width/);
  assert.throws(() => packedVisibilityAttachmentDescriptor(1, -1), /height/);
});

test("R4-A-02 FrameGraph owns the Key attachment only when the Packed pass exists", () => {
  const empty = new FrameGraph("R4 feature off");
  assert.equal(empty.resourceNodeCount, 0);

  const graph = new FrameGraph("R4 Hardware opaque");
  const imported = Array.from({ length: 5 }, (_, index) =>
    graph.import_resource(
      `input-${index}`,
      { kind: "imported", label: `input-${index}` },
      { index }
    )
  );
  const pass = new PackedVisibilityPass({
    device: {
      limits: {
        maxBufferSize: 1 << 28,
        maxStorageBufferBindingSize: 1 << 28
      },
      createShaderModule: (descriptor) => ({ descriptor }),
      createBindGroupLayout: (descriptor) => ({ descriptor }),
      createPipelineLayout: (descriptor) => ({ descriptor }),
      createComputePipeline: (descriptor) => ({ descriptor })
    }
  });
  const outputs = pass.addToGraph(
    graph,
    {
      runtime: {},
      assets: {},
      scene: {},
      countersEnabled: false,
      width: 640,
      height: 360,
      hierarchyView: {},
      sseThreshold: 4,
      coneEnabled: false,
      previousHzb: null
    },
    {
      camera: imported[0],
      counters: imported[1],
      triangleId: imported[2],
      instanceId: imported[3],
      depth: imported[4]
    }
  );

  assert.notEqual(outputs.counters, imported[1]);
  assert.equal(
    graph.getResourceNode(outputs.counters).resource_id,
    graph.getResourceNode(imported[1]).resource_id
  );
  assert.deepEqual(graph.getDescriptor(outputs.visibilityKey),
    packedVisibilityAttachmentDescriptor(640, 360));
  graph.compile();
  assert.equal(
    graph.getResourceNode(outputs.visibilityKey).producer?.name,
    "Packed Visibility/R4-A-02 Hardware opaque producer"
  );
  assert.deepEqual(
    graph.listExecutablePasses().map(({ name, culled }) => ({ name, culled })),
    [{
      name: "Packed Visibility/R4-A-02 Hardware opaque producer",
      culled: false
    }]
  );
  pass.destroy();
});

test("R4-A-02 fragment evidence is honest about the WebGPU baseline", () => {
  assert.deepEqual(PACKED_VISIBILITY_FRAGMENT_EVIDENCE, {
    submittedFragments: {
      status: "unsupported",
      blockerTaskId: "R4-A-06",
      reason: "OEngine WebGPU baseline has no negotiated pipeline statistics producer"
    },
    usefulFragments: {
      status: "supported",
      counter: "shadedPixels",
      producer: "VisibilityCounterPass/VisibilityKey v1 final-pixel reducer"
    },
    invalidKeys: {
      status: "supported",
      counter: "invalidVisibilityKeys",
      producer: "VisibilityCounterPass/VisibilityKey v1 invalid reducer"
    }
  });
});
