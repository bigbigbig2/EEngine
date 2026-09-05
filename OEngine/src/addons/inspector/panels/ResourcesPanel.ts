import type { ResourceAccountingSnapshot, AccountedResourceCategory, AccountedResourceKind } from "../../../debug/profiling/ResourceAccounting.js";

export interface RendererMemoryEvidenceLike {
  readonly allocatedBytes: number;
  readonly residentLogicalBytes: number;
  readonly transientPoolBytes: number;
  readonly retiringBytes: number;
  readonly reclaimableBytes: number;
  readonly fragmentationBytes: number;
  readonly owners: Readonly<Record<string, Readonly<Record<string, number>>>>;
}

export interface ResourceDisplayRow {
  readonly owner: string;
  readonly kind: AccountedResourceKind | "aggregate" | "memory";
  readonly count: number | null;
  readonly currentBytes: number;
  readonly peakBytes: number | null;
  readonly measurement: "accounted" | "estimated";
}

const CATEGORIES: readonly AccountedResourceCategory[] = [
  "resident", "transient", "history", "atlas", "upload", "readback", "profiler"
];

export function buildResourceRows(
  accounting: ResourceAccountingSnapshot | null,
  memory: RendererMemoryEvidenceLike | null = null
): readonly ResourceDisplayRow[] {
  const rows: ResourceDisplayRow[] = [];
  if (accounting !== null) {
    for (const category of CATEGORIES) {
      const values = accounting.categories[category];
      if (values === undefined) continue;
      rows.push(Object.freeze({
        owner: category,
        kind: "aggregate" as const,
        count: values.count,
        currentBytes: values.bytes,
        peakBytes: values.peakBytes,
        measurement: "accounted" as const
      }));
    }
    for (const [owner, kinds] of Object.entries(accounting.owners)) {
      for (const [kind, bytes] of Object.entries(kinds)) {
        rows.push(Object.freeze({
          owner,
          kind: kind as AccountedResourceKind,
          count: null,
          currentBytes: bytes,
          peakBytes: null,
          measurement: "accounted" as const
        }));
      }
    }
  }
  if (memory !== null) {
    rows.push(Object.freeze({
      owner: "GraphicsContext",
      kind: "memory" as const,
      count: 1,
      currentBytes: memory.allocatedBytes,
      peakBytes: null,
      measurement: "estimated" as const
    }));
  }
  return Object.freeze(rows);
}

export class ResourcesPanel {
  readonly element: HTMLElement;
  private readonly table: HTMLElement;

  constructor(document: Document) {
    this.element = document.createElement("section");
    this.element.className = "domain-panel resources-panel";
    const heading = document.createElement("h3");
    heading.textContent = "Resources";
    this.table = document.createElement("pre");
    this.element.append(heading, this.table);
  }

  update(accounting: ResourceAccountingSnapshot | null, memory: RendererMemoryEvidenceLike | null): void {
    const rows = buildResourceRows(accounting, memory);
    this.table.textContent = rows.length === 0
      ? "Resource accounting unavailable"
      : rows.map((row) => `${row.owner} · ${row.kind} · count ${row.count ?? "unsupported"} · current ${row.currentBytes} B · peak ${row.peakBytes ?? "unsupported"} B · ${row.measurement}`).join("\n");
  }
}
