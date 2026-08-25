/**
 * UsdErrors：解析 USD 数据并转换为引擎运行时对象。
 */

export class UsdParseError extends Error {
  readonly context: Record<string, unknown>;

  constructor(message: string, context?: Record<string, unknown>) {
    super(message);
    this.name = "UsdParseError";
    this.context = context || {};
  }
}

export class UsdUnsupportedError extends Error {
  readonly feature: string;

  constructor(feature: string) {
    super(`Unsupported USD feature: ${feature}`);
    this.name = "UsdUnsupportedError";
    this.feature = feature;
  }
}
