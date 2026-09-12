import type { PassResources, FrameGraphContext } from "../../framegraph/FrameGraph.js";
import type { ShadeGPUCommandContext } from "../../framegraph/ShadeGPUCommandContext.js";
import type { ShadingBinFrameBindings, ShadingBinPass } from "../passes/ShadingBinPass.js";
import type {
  SparseShadingResolveFrameBinding,
  SparseShadingResolvePass
} from "../passes/SparseShadingResolvePass.js";
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
  readonly binBindings: Readonly<ShadingBinFrameBindings>;
  readonly resolve: Pick<
    SparseShadingResolvePass,
    "publicationRevision" | "activeBinIds" | "encode"
  >;
  readonly resolveBindings: readonly SparseShadingResolveFrameBinding[];
  readonly settingsDynamicOffset: number;
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
  if (new Set(activeBins).size !== activeBins.length ||
      input.resolveBindings.length !== activeBins.length) {
    throw new Error("Sparse shading resolve bindings must cover the immutable active-bin set");
  }

  return (stage, frame, resources, context): void => {
    const command = requireCommand(context);
    if (stage === "bin-clear-classify") {
      assertBinResources(frame, resources, input);
      input.bins.encodeClassify(command, input.binBindings);
      return;
    }
    if (stage === "bin-finalize") {
      assertBinResources(frame, resources, input);
      input.bins.encodeFinalize(command, input.binBindings);
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
      input.resolve.encode(
        command,
        input.bins.indirectArgs,
        input.settingsDynamicOffset,
        input.resolveBindings,
        frame.plan.publicationRevision
      );
      return;
    }
    input.executeExternalStage(stage, frame, resources, context);
  };
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
