import {
  decodeSurfaceDiagnostics,
  SURFACE_DIAGNOSTICS_BYTE_SIZE,
  type SurfaceDiagnosticsIdentity,
  type SurfaceDiagnosticsMode,
  type SurfaceDiagnosticsSnapshot,
} from "../gpu/SurfaceDiagnosticsAbi.js";
import { GpuReadbackRing, type GpuReadbackRingStats, type GpuReadbackTicket } from "./GpuReadbackRing.js";
import type { ResourceAccounting } from "./profiling/ResourceAccounting.js";

export interface SurfaceDiagnosticsCaptureOptions {
  readonly mode?: SurfaceDiagnosticsMode;
  readonly slotCount?: number;
  readonly resourceAccounting?: ResourceAccounting;
  readonly onSnapshot?: (snapshot: SurfaceDiagnosticsSnapshot) => void;
}

/** Owns only the small Surface diagnostic snapshot readback. */
export class SurfaceDiagnosticsCapture {
  readonly mode: SurfaceDiagnosticsMode;
  private readonly ring: GpuReadbackRing | null;
  private readonly onSnapshot?: (snapshot: SurfaceDiagnosticsSnapshot) => void;
  private readonly identities = new Map<string, SurfaceDiagnosticsIdentity>();
  private destroyed = false;

  constructor(device: GPUDevice, options: SurfaceDiagnosticsCaptureOptions = {}) {
    this.mode = options.mode ?? "off";
    this.onSnapshot = options.onSnapshot;
    this.ring =
      this.mode === "detailed"
        ? new GpuReadbackRing(device, {
            byteLength: SURFACE_DIAGNOSTICS_BYTE_SIZE,
            slotCount: options.slotCount ?? 3,
            label: "Surface diagnostics snapshot readback",
            resourceAccounting: options.resourceAccounting,
            resourceCategory: "readback",
            resourceOwner: "SurfaceDiagnosticsCapture",
            onResult: ({ frameIndex, data, runId, deviceEpoch }) => {
              const identityKey = readbackKey(runId, deviceEpoch, frameIndex);
              const identity = this.identities.get(identityKey) ?? {
                runId: runId ?? "unknown",
                deviceEpoch: deviceEpoch ?? 0,
                frameId: frameIndex,
              };
              this.identities.delete(identityKey);
              const snapshot = decodeSurfaceDiagnostics(data, identity, this.mode);
              this.onSnapshot?.(snapshot);
            },
            onError: ({ frameIndex, error, runId, deviceEpoch }) => {
              for (const [key, identity] of this.identities) {
                if (
                  identity.frameId === frameIndex &&
                  (runId === undefined || identity.runId === runId) &&
                  (deviceEpoch === undefined || identity.deviceEpoch === deviceEpoch)
                )
                  this.identities.delete(key);
              }
              this.onSnapshot?.({
                runId: runId ?? "unknown",
                deviceEpoch: deviceEpoch ?? 0,
                frameId: frameIndex,
                schemaVersion: 1,
                mode: this.mode,
                availability: "invalid",
                values: {},
                coverage: { status: "unknown", violations: [String(error)] },
                reconstructLogicalBytes: null,
              });
            },
          })
        : null;
  }

  get stats(): GpuReadbackRingStats {
    return this.ring?.stats ?? { slotCount: 0, pending: 0, completed: 0, dropped: 0, failed: 0 };
  }

  encodeReadback(
    encoder: Pick<GPUCommandEncoder, "copyBufferToBuffer">,
    source: GPUBuffer,
    identity: SurfaceDiagnosticsIdentity,
  ): GpuReadbackTicket | null {
    if (this.destroyed || this.ring === null) return null;
    const ticket = this.ring.encodeCopy(encoder, source, 0, identity.frameId, {
      runId: identity.runId,
      deviceEpoch: identity.deviceEpoch,
    });
    if (ticket === null) return null;
    this.identities.set(readbackKey(identity.runId, identity.deviceEpoch, identity.frameId), identity);
    return ticket;
  }

  markSubmitted(ticket: GpuReadbackTicket): void {
    if (!this.destroyed) this.ring?.markSubmitted(ticket);
  }

  cancel(ticket: GpuReadbackTicket, error: unknown): void {
    if (!this.destroyed) this.ring?.cancel(ticket, error);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.identities.clear();
    this.ring?.destroy();
  }
}

function readbackKey(runId: string | undefined, deviceEpoch: number | undefined, frameId: number): string {
  return `${runId ?? "unknown"}:${deviceEpoch ?? 0}:${frameId}`;
}
