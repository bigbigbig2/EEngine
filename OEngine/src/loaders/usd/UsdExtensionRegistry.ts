/**
 * UsdExtensionRegistry：解析 USD 数据并转换为引擎运行时对象。
 */

import type { Node3D } from "../../scene/Node3D.js";

export type UsdExtension = {
  name: string;
  processPrim?: (
    path: string,
    fields: Record<string, unknown>,
    ctx: {
      specs_by_path: UsdSpecsByPath;
      materials: Map<string, unknown>;
      options: LoadUsdOptionsInternal;
    }
  ) => Node3D | null;
  postProcess?: (specsByPath: UsdSpecsByPath) => void;
};

export type UsdSpec = {
  specType: number;
  fields: Record<string, unknown>;
};

export type UsdSpecsByPath = Record<string, UsdSpec>;

export type LoadUsdOptionsInternal = {
  fileName?: string;
  assetFiles?: Map<string, Uint8Array>;
  extensions?: UsdExtensionRegistry;
};

export class UsdExtensionRegistry {
  private _extensions = new Map<string, UsdExtension>();

  register(name: string, extension: UsdExtension): void {
    this._extensions.set(name, extension);
  }

  unregister(name: string): void {
    this._extensions.delete(name);
  }

  get(name: string): UsdExtension | undefined {
    return this._extensions.get(name);
  }

  values(): IterableIterator<UsdExtension> {
    return this._extensions.values();
  }

  get size(): number {
    return this._extensions.size;
  }
}

export const defaultUsdExtensions = new UsdExtensionRegistry();
