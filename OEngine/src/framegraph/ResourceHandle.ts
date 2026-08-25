/**
 * ResourceHandle：负责帧图资源管理、依赖编排或 GPU 命令执行。
 */

export type ResourceId = number;

export type ResourceDescriptor =
  | { kind: "imported"; label?: string }
  | {
      kind: "transient_texture";
      label?: string;
      width: number;
      height: number;
      format: string;
      usage?: number;
      depthOrArrayLayers?: number;
      dimension?: GPUTextureDimension;
      mipLevelCount?: number;
    }
  | {
      kind: "transient_buffer";
      label?: string;
      size: number;
      usage?: number;
      ensure_cleared?: readonly [offset: number, size: number];
    }
  | { kind: "opaque"; label?: string; [key: string]: unknown };

export interface ResourceNode {
  id: ResourceId;
  name: string;
  resource_id: number;
  version: number;
  ref_count: number;
  producer: PassNodeRef | null;
  readonly isResourceNode: true;
}

export interface ResourceEntry {
  resource_id: number;
  resource_descriptor: ResourceDescriptor | null;
  resource_version: number;
  resource: unknown;
  imported: boolean;
  producer: PassNodeRef | null;
  last: PassNodeRef | null;
}

export interface PassNodeRef {
  id: number;
  name: string;
}

export function isTransientEntry(entry: ResourceEntry): boolean {
  return !entry.imported;
}

export function isImportedEntry(entry: ResourceEntry): boolean {
  return entry.imported;
}
