export interface InspectorLayout {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

export interface InspectorLayoutStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export type InspectorLayoutListener = (layout: InspectorLayout) => void;

const STORAGE_KEY = "oengine-performance-inspector-layout-v1";
const DEFAULT_LAYOUT: InspectorLayout = Object.freeze({ left: 12, top: 96, width: 520, height: 420 });
const MIN_WIDTH = 320;
const MIN_HEIGHT = 220;
const MAX_WIDTH = 960;
const MAX_HEIGHT = 900;

function finite(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function normalize(value: Partial<InspectorLayout>, fallback = DEFAULT_LAYOUT): InspectorLayout {
  return Object.freeze({
    left: Math.max(0, finite(value.left, fallback.left)),
    top: Math.max(0, finite(value.top, fallback.top)),
    width: Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, finite(value.width, fallback.width))),
    height: Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, finite(value.height, fallback.height)))
  });
}

function defaultStorage(): InspectorLayoutStorage | null {
  try {
    const storage = globalThis.localStorage;
    return storage === undefined ? null : storage;
  } catch {
    return null;
  }
}

/** Deep, DOM-free layout state for the floating Inspector shell. */
export class InspectorLayoutModel {
  private layoutValue: InspectorLayout;
  private readonly storage: InspectorLayoutStorage | null;
  private readonly listeners = new Set<InspectorLayoutListener>();

  constructor(storage: InspectorLayoutStorage | null = defaultStorage()) {
    this.storage = storage;
    this.layoutValue = this.readStored();
  }

  get layout(): InspectorLayout {
    return this.layoutValue;
  }

  setLayout(next: Partial<InspectorLayout>, persist = true): InspectorLayout {
    this.layoutValue = normalize(next, this.layoutValue);
    if (persist) this.persist();
    for (const listener of this.listeners) listener(this.layoutValue);
    return this.layoutValue;
  }

  reset(): InspectorLayout {
    this.layoutValue = DEFAULT_LAYOUT;
    this.persist();
    for (const listener of this.listeners) listener(this.layoutValue);
    return this.layoutValue;
  }

  subscribe(listener: InspectorLayoutListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private readStored(): InspectorLayout {
    if (this.storage === null) return DEFAULT_LAYOUT;
    try {
      const raw = this.storage.getItem(STORAGE_KEY);
      if (raw === null) return DEFAULT_LAYOUT;
      const value: unknown = JSON.parse(raw);
      if (value === null || typeof value !== "object") return DEFAULT_LAYOUT;
      return normalize(value as Partial<InspectorLayout>);
    } catch {
      return DEFAULT_LAYOUT;
    }
  }

  private persist(): void {
    if (this.storage === null) return;
    try {
      this.storage.setItem(STORAGE_KEY, JSON.stringify(this.layoutValue));
    } catch {
      // Storage is optional (private mode, blocked origin, or quota exceeded).
    }
  }
}

export const INSPECTOR_LAYOUT_DEFAULTS = DEFAULT_LAYOUT;
