/**
 * Immutable opaque-consumer demand ABI shared by sparse publication and the
 * render graph.  Derivation belongs to the render planning layer so this GPU
 * data contract does not depend on render/debug policy.
 *
 * The snapshot describes products required by opaque consumers, not the
 * products that happen to be visible in one frame.  That distinction keeps
 * shader/layout publication stable while the camera moves and makes feature
 * off pruning observable in the compiled graph.
 */
export interface OpaqueShadingDemand {
  readonly hasOpaqueReceiver: boolean;
  readonly hasOpaqueLitReceiver: boolean;
  readonly hasOpaqueUnlitReceiver: boolean;
  readonly needsHdr: boolean;
  readonly needsSurface: boolean;
  readonly needsDiffuseSurface: boolean;
  readonly needsVelocity: boolean;
  readonly needsPreviousDepth: boolean;
  readonly needsIndirectComponents: boolean;
  readonly needsLightingDebug: boolean;
  readonly needsEnvironmentIbl: boolean;
  readonly shadowSamplingEnabled: boolean;
  readonly outputDependencyMask: number;
}
