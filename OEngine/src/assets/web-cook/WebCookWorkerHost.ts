import { WebCookCoordinator, type WebRuntimeCooker } from "./WebCookCoordinator.js";
import { WEB_COOK_PAGE_BYTES, WEB_COOK_PROTOCOL_VERSION, type WebCookBudgets, type WebCookCommand, type WebCookEvent, type WebCookRuntimeProfile } from "./protocol/CookSessionProtocol.js";
import type { GlbRangeSourceOptions } from "../../loaders/gltf/streaming/GlbRangeSource.js";

export interface WebCookWorkerHostPort {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  addEventListener(type: "message", listener: (event: MessageEvent<unknown>) => void): void;
  removeEventListener(type: "message", listener: (event: MessageEvent<unknown>) => void): void;
}

export interface WebCookWorkerHostOptions {
  readonly port: WebCookWorkerHostPort;
  readonly cooker: WebRuntimeCooker;
  readonly source?: GlbRangeSourceOptions;
}

/** Dedicated Worker-side command host. It owns CPU/WASM cook state only. */
export class WebCookWorkerHost {
  readonly #options: WebCookWorkerHostOptions;
  readonly #listener = (event: MessageEvent<unknown>): void => { void this.receive(event.data); };
  #coordinator: WebCookCoordinator | undefined;
  #running = false;
  #closed = false;
  #sessionId = "";
  #generation = 0;

  constructor(options: WebCookWorkerHostOptions) {
    this.#options = options;
    options.port.addEventListener("message", this.#listener);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#options.port.removeEventListener("message", this.#listener);
    this.#coordinator?.dispose();
    this.#coordinator = undefined;
  }

  receive(value: unknown): Promise<void> { return this.#accept(value); }

  async #accept(value: unknown): Promise<void> {
    if (this.#closed) return;
    try {
      const command = assertCommand(value);
      if (command.type === "CreateSession") {
        this.#create(command);
        return;
      }
      if (!this.#coordinator || command.sessionId !== this.#sessionId || command.sessionGeneration !== this.#generation) return;
      if (command.type === "OpenSource") {
        const url = command.source.url;
        if (typeof url !== "string" || url.length === 0) throw new Error("OpenSource requires a URL source descriptor");
        await this.#coordinator.open(url);
        this.#startCooking();
      } else if (command.type === "GrantOutputCredits") {
        this.#coordinator.grantOutputCredits(command.blockCount, command.bytes);
      } else if (command.type === "ReturnOutputCredits") {
        this.#coordinator.returnOutputCredits(command.blockCount, command.bytes);
      } else if (command.type === "CancelScope") {
        this.#coordinator.cancel(new Error(`Web Cook cancelled: ${command.scope}`));
      } else if (command.type === "DisposeSession") {
        this.close();
        return;
      } else if (command.type === "SetSourcePriority" || command.type === "RequestPages") {
        // Scheduling and non-activation Page requests are handled by the next residency slice.
      }
      this.#flushEvents();
    } catch (error) {
      this.#emit({ protocolVersion: WEB_COOK_PROTOCOL_VERSION, sessionId: this.#sessionId, sessionGeneration: this.#generation, type: "FatalSessionFailure", code: error instanceof Error ? error.message : String(error) });
      this.#coordinator?.dispose();
      this.#coordinator = undefined;
    }
  }

  #create(command: Extract<WebCookCommand, { type: "CreateSession" }>): void {
    if (this.#coordinator || this.#running) throw new Error("Web Cook Worker already owns a session");
    this.#sessionId = command.sessionId;
    this.#generation = command.sessionGeneration;
    this.#coordinator = new WebCookCoordinator(command.sessionId, command.sessionGeneration, {
      budgets: command.budgets,
      runtimeProfile: command.runtimeProfile,
      recipe: command.recipe,
      source: this.#options.source,
      cooker: this.#options.cooker
    });
  }

  #startCooking(): void {
    if (this.#running || !this.#coordinator) return;
    this.#running = true;
    void this.#coordinator.cookBootstrap().then(() => this.#flushEvents()).catch(error => {
      this.#flushEvents();
      this.#emit({ protocolVersion: WEB_COOK_PROTOCOL_VERSION, sessionId: this.#sessionId, sessionGeneration: this.#generation, type: "FatalSessionFailure", code: error instanceof Error ? error.message : String(error) });
    });
  }

  #flushEvents(): void {
    const coordinator = this.#coordinator;
    if (!coordinator) return;
    for (const event of coordinator.drainEvents()) {
      const transfer: Transferable[] = [];
      if (event.type === "PageReady") transfer.push(event.bytes);
      if (event.type === "RevisionOffered") transfer.push(event.descriptor);
      this.#emit(event, transfer);
    }
  }

  #emit(event: WebCookEvent, transfer: Transferable[] = []): void { if (!this.#closed) this.#options.port.postMessage(event, transfer); }
}

export function installWebCookWorkerHost(options: WebCookWorkerHostOptions): WebCookWorkerHost {
  return new WebCookWorkerHost(options);
}

function assertCommand(value: unknown): WebCookCommand {
  if (!value || typeof value !== "object") throw new TypeError("Web Cook Worker received a non-object command");
  const command = value as Partial<WebCookCommand>;
  if (command.protocolVersion !== WEB_COOK_PROTOCOL_VERSION || typeof command.sessionId !== "string" || !Number.isInteger(command.sessionGeneration)) throw new Error("Web Cook Worker received an incompatible command header");
  if (!["CreateSession", "OpenSource", "SetSourcePriority", "RequestPages", "GrantOutputCredits", "ReturnOutputCredits", "CancelScope", "DisposeSession"].includes(String(command.type))) throw new Error(`Web Cook Worker received unknown command '${String(command.type)}'`);
  return command as WebCookCommand;
}
