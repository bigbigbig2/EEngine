export interface RendererDebugConfig {
  /** Master switch. An object without `enabled` is treated as enabled. */
  readonly enabled?: boolean;
  readonly controls?: boolean;
  readonly info?: boolean;
  /** Expands the built-in folders on creation. */
  readonly expanded?: boolean;
  /** Renderer Info refresh cadence in Hz. */
  readonly infoRefreshRate?: number;
}

export interface ResolvedRendererDebugConfig {
  readonly enabled: boolean;
  readonly controls: boolean;
  readonly info: boolean;
  readonly expanded: boolean;
  readonly infoRefreshRate: number;
}

const DISABLED: ResolvedRendererDebugConfig = Object.freeze({
  enabled: false,
  controls: false,
  info: false,
  expanded: false,
  infoRefreshRate: 4
});

export function resolveRendererDebugConfig(
  value: boolean | RendererDebugConfig | undefined
): ResolvedRendererDebugConfig {
  if (value === undefined || value === false) return DISABLED;
  const input = value === true ? {} : value;
  const enabled = input.enabled ?? true;
  const infoRefreshRate = input.infoRefreshRate ?? 4;
  if (!Number.isFinite(infoRefreshRate) || infoRefreshRate < 1 || infoRefreshRate > 10) {
    throw new RangeError("Renderer debug infoRefreshRate must be between 1 and 10 Hz");
  }
  return Object.freeze({
    enabled,
    controls: enabled && (input.controls ?? true),
    info: enabled && (input.info ?? true),
    expanded: input.expanded ?? false,
    infoRefreshRate
  });
}

