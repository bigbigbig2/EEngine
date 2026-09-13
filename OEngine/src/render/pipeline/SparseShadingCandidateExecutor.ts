import type { PassResources, FrameGraphContext } from "../../framegraph/FrameGraph.js";
import type { ResourceId } from "../../framegraph/ResourceHandle.js";
import type { ShadeGPUCommandContext } from "../../framegraph/ShadeGPUCommandContext.js";
import type { ShadingBinFrameBindings, ShadingBinPass } from "../passes/ShadingBinPass.js";
import type {
  SparseShadingResolveFrameBinding,
  SparseShadingResolvePass
} from "../passes/SparseShadingResolvePass.js";
import type { SparseShadingDiagnosticsPass } from "../passes/SparseShadingDiagnosticsPass.js";
import type {
  SparseShadingCandidateFrame,
  SparseShadingCandidateStage,
  SparseShadingCandidateStageExecutor
} from "./SparseShadingCandidatePipeline.js";

export interface SparseShadingCandidateExecutorInput {
  readonly bins: Pick<
    ShadingBinPass,
    "heap" | "indirectArgs" | "encodeClassify" | "encodeFinalize"
  >;
  /**
   * FrameGraph transient textures do not exist until execution. Bind groups
   * which reference Visibility/ShadingBin resources therefore belong to this
   * execution-time factory, not to candidate-plan construction.
   */
  readonly createBinBindings: (
    frame: Readonly<SparseShadingCandidateFrame>,
    resources: PassResources
  ) => Readonly<ShadingBinFrameBindings>;
  readonly resolve: Pick<
    SparseShadingResolvePass,
    "publicationRevision" | "activeBinIds" | "encode"
  >;
  /** Creates bind groups after every transient resolve target is materialized. */
  readonly createResolveBindings: (
    frame: Readonly<SparseShadingCandidateFrame>,
    resources: PassResources
  ) => readonly SparseShadingResolveFrameBinding[];
  readonly settingsDynamicOffset: number;
  readonly diagnostics?: Pick<SparseShadingDiagnosticsPass, "encodeFinalize" | "encodeCopy">;
  readonly executeExternalStage: SparseShadingCandidateStageExecutor;
}

/**
 * Binds the Step 4 producer and Step 5 consumer to the candidate graph. It only
 * records into the graph-owned ShadeGPUCommandContext and never submits/maps.
 */
export function createSparseShadingCandidateExecutor(
  input: Readonly<SparseShadingCandidateExecutorInput>
): SparseShadingCandidateStageExecutor {
  if (!Number.isSafeInteger(input.settingsDynamicOffset) || input.settingsDynamicOffset < 0) {
    throw new RangeError("Sparse shading settings offset must be a non-negative safe integer");
  }
  const activeBins = Object.freeze([...input.resolve.activeBinIds]);
  if (new Set(activeBins).size !== activeBins.length) {
    throw new Error("Sparse shading resolve owner has duplicate active bins");
  }
  const binBindingsByExecution = new WeakMap<FrameGraphContext, Readonly<ShadingBinFrameBindings>>();

  return (stage, frame, resources, context): void => {
    const command = requireCommand(context);
    if (stage === "bin-clear-classify") {
      assertBinResources(frame, resources, input);
      clearDiagnostics(command, frame, resources);
      const binBindings = input.createBinBindings(frame, resources);
      if (binBindings.settingsDynamicOffset !== input.settingsDynamicOffset) {
        throw new Error("Sparse shading bin bindings use a different settings offset");
      }
      binBindingsByExecution.set(context, binBindings);
      input.bins.encodeClassify(command, binBindings);
      return;
    }
    if (stage === "bin-finalize") {
      assertBinResources(frame, resources, input);
      const binBindings = binBindingsByExecution.get(context);
      if (binBindings === undefined) {
        throw new Error("Sparse shading finalizer executed without classifier bindings");
      }
      input.bins.encodeFinalize(command, binBindings);
      return;
    }
    if (stage === "bin-resolve") {
      assertBinResources(frame, resources, input);
      if (frame.plan.publicationRevision !== input.resolve.publicationRevision) {
        throw new Error("Sparse shading resolve owner does not match the graph publication");
      }
      if (!sameNumbers(frame.plan.activeBinIds, activeBins)) {
        throw new Error("Sparse shading resolve owner does not match the graph active-bin set");
      }
      const resolveBindings = input.createResolveBindings(frame, resources);
      if (resolveBindings.length !== activeBins.length ||
          !sameNumbers(resolveBindings.map((binding) => binding.binId).sort((left, right) => left - right),
            [...activeBins].sort((left, right) => left - right))) {
        throw new Error("Sparse shading resolve bindings must cover the immutable active-bin set");
      }
      input.resolve.encode(
        command,
        input.bins.indirectArgs,
        input.settingsDynamicOffset,
        resolveBindings,
        frame.plan.publicationRevision
      );
      binBindingsByExecution.delete(context);
      return;
    }
    if (stage === "diagnostics-finalize") {
      const diagnostics = requireDiagnosticsOwner(input);
      diagnostics.encodeFinalize(command, {
        shadingBinId: requireTextureView(frame.shadingBinId, resources, "ShadingBinId"),
        settings: requireBuffer(frame.settings, resources, "settings"),
        settingsDynamicOffset: input.settingsDynamicOffset,
        claims: requireBuffer(frame.claims, resources, "claims"),
        diagnostics: requireBuffer(frame.diagnostics, resources, "diagnostics"),
        width: frame.plan.width,
        height: frame.plan.height
      });
      return;
    }
    if (stage === "diagnostics-copy") {
      const diagnostics = requireDiagnosticsOwner(input);
      diagnostics.encodeCopy(
        command,
        requireBuffer(frame.diagnostics, resources, "diagnostics"),
        requireBuffer(frame.diagnosticsReadback, resources, "diagnostics readback")
      );
      return;
    }
    input.executeExternalStage(stage, frame, resources, context);
  };
}

function clearDiagnostics(
  command: ShadeGPUCommandContext,
  frame: Readonly<SparseShadingCandidateFrame>,
  resources: PassResources
): void {
  if (frame.claims === null && frame.diagnostics === null) return;
  command.clearBuffer(requireBuffer(frame.claims, resources, "claims"));
  command.clearBuffer(requireBuffer(frame.diagnostics, resources, "diagnostics"));
}

function requireDiagnosticsOwner(
  input: Readonly<SparseShadingCandidateExecutorInput>
): Pick<SparseShadingDiagnosticsPass, "encodeFinalize" | "encodeCopy"> {
  if (input.diagnostics === undefined) {
    throw new Error("Sparse shading diagnostics topology requires its isolated pipeline owner");
  }
  return input.diagnostics;
}

function requireBuffer(
  id: ResourceId | null,
  resources: PassResources,
  label: string
): GPUBuffer {
  if (id === null) throw new Error(`Sparse shading candidate omitted ${label}`);
  const value = resources.get(id);
  if (value === null || value === undefined || typeof value !== "object") {
    throw new Error(`Sparse shading candidate ${label} is unavailable`);
  }
  return value as GPUBuffer;
}

function requireTextureView(
  id: ResourceId | null,
  resources: PassResources,
  label: string
): GPUTextureView {
  if (id === null) throw new Error(`Sparse shading candidate omitted ${label}`);
  const value = resources.get(id);
  if (value === null || value === undefined || typeof value !== "object") {
    throw new Error(`Sparse shading candidate ${label} is unavailable`);
  }
  if ("createView" in value && typeof value.createView === "function") {
    return value.createView();
  }
  return value as GPUTextureView;
}

function assertBinResources(
  frame: Readonly<SparseShadingCandidateFrame>,
  resources: PassResources,
  input: Readonly<SparseShadingCandidateExecutorInput>
): void {
  if (frame.heap === null || frame.indirectArgs === null || frame.settings === null) {
    throw new Error("Sparse shading graph omitted required bin resources");
  }
  if (resources.get(frame.heap) !== input.bins.heap ||
      resources.get(frame.indirectArgs) !== input.bins.indirectArgs) {
    throw new Error("Sparse shading graph and revision-owned bin resources disagree");
  }
  // Resolve this handle as part of the closure check even though its bind group
  // was prepared transactionally before graph execution.
  if (resources.get(frame.settings) === undefined) {
    throw new Error("Sparse shading settings resource is unavailable");
  }
}

function requireCommand(context: FrameGraphContext): ShadeGPUCommandContext {
  const command = context.encoder;
  if (command === null || typeof command !== "object" ||
      !("isGPUCommandContext" in command) || command.isGPUCommandContext !== true) {
    throw new Error("Sparse shading candidate requires the main ShadeGPUCommandContext");
  }
  return command as ShadeGPUCommandContext;
}

function sameNumbers(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
