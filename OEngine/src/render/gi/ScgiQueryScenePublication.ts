import type { ShadeGPUCommandContext } from "../../framegraph/ShadeGPUCommandContext.js";
import type { ScgiQueryScene } from "./ScgiQueryScene.js";

/** One query-scene publication point. Missing fine pages leave active intact;
 * a complete replacement is visible only in its build command until submit.
 * Scene owners retain their own pages/materials and all consumer fences. */
export class ScgiQueryScenePublication {
  private active: ScgiQueryScene | null = null;
  private candidate: { scene: ScgiQueryScene; command: ShadeGPUCommandContext } | null = null;
  private retiring = 0;
  private failure: unknown;
  private poisoned = false;
  private closed = false;

  get current(): ScgiQueryScene | null {
    return this.closed || this.poisoned ? null : this.active;
  }

  get retiringCount(): number {
    return this.retiring;
  }

  get error(): unknown {
    return this.failure;
  }

  frameReadable(command: ShadeGPUCommandContext): ScgiQueryScene | null {
    if (this.closed || this.poisoned) {
      return null;
    }
    return this.candidate?.command === command ? this.candidate.scene : this.active;
  }

  stage(scene: ScgiQueryScene, command: ShadeGPUCommandContext): void {
    if (this.closed || this.poisoned || this.candidate !== null ||
        !scene.prepared || command.closed) {
      throw new Error("Query scene publication requires one complete unused candidate");
    }
    scene.encode(command);
    const candidate = { scene, command };
    this.candidate = candidate;
    command.observeSubmission({
      submitted: (fence) => {
        const previous = this.active;
        this.active = scene;
        this.candidate = null;
        if (previous !== null) {
          this.retireScene(previous, fence);
        }
        void fence.catch((error) => {
          this.poisoned = true;
          this.failure = error;
        });
      },
      aborted: () => {
        // The scene's own abort observer releases only candidate resources.
        if (this.candidate === candidate) {
          this.candidate = null;
        }
      },
      failed: (error) => {
        this.poisoned = true;
        this.failure = error;
        this.candidate = null;
      },
    });
  }

  /** Disable/replace at the composition boundary. A caller-supplied final
   * fence joins the scene's registered consumers; no new submit is needed. */
  retire(completion: Promise<void>): void {
    if (this.candidate !== null) {
      throw new Error("Abort or submit the query candidate before retiring its publication");
    }
    this.closed = true;
    const previous = this.active;
    this.active = null;
    if (previous !== null) {
      this.retireScene(previous, completion);
    }
  }

  private retireScene(scene: ScgiQueryScene, completion: Promise<void>): void {
    this.retiring++;
    void scene.releaseAfter(completion).then(() => {
      this.retiring--;
    }, (error) => {
      // Failed leases remain quarantined and keep their retiring accounting.
      this.poisoned = true;
      this.failure = error;
    });
  }
}
