import {
  buildBoxSourceGeometry,
  openRuntimeAssetPackage,
  validateRuntimeAssetPackage,
  writeRuntimeAssetPackage
} from "../../OEngine/src/index.ts";

const EXAMPLE_SOURCE_SUMMARY = 0x7f000001;
const status = requiredElement<HTMLElement>("status");
const summary = requiredElement<HTMLElement>("summary");
const result = requiredElement<HTMLElement>("result");

void run().catch((error: unknown) => {
  status.textContent = "验证失败";
  status.className = "error";
  result.textContent = error instanceof Error
    ? error.stack ?? error.message
    : String(error);
  console.error(error);
});

async function run(): Promise<void> {
  const source = buildBoxSourceGeometry(2, 4, 6);
  const sourceSummary = new TextEncoder().encode(JSON.stringify({
    sourceId: source.sourceId,
    vertexCount: source.vertexCount,
    triangleCount: source.triangleCount,
    materialRanges: source.materialRanges,
    bounds: {
      box: [...source.bounds.box],
      sphere: [...source.bounds.sphere]
    }
  }));
  const bytes = await writeRuntimeAssetPackage({
    sections: [{
      type: EXAMPLE_SOURCE_SUMMARY,
      required: true,
      data: sourceSummary,
      elementStride: 1,
      elementCount: sourceSummary.byteLength,
      alignment: 16
    }]
  });
  const pkg = await openRuntimeAssetPackage(bytes, {
    supportedSectionTypes: new Set([EXAMPLE_SOURCE_SUMMARY])
  });
  const corrupted = bytes.slice(0);
  const section = pkg.section(EXAMPLE_SOURCE_SUMMARY);
  if (section === undefined) throw new Error("Example summary section is missing");
  new Uint8Array(corrupted)[section.byteOffset] ^= 0xff;
  const corruption = await validateRuntimeAssetPackage(corrupted, {
    supportedSectionTypes: new Set([EXAMPLE_SOURCE_SUMMARY])
  });
  const artifact = {
    passed: pkg.validate().valid && !corruption.valid,
    source: {
      id: source.sourceId,
      vertices: source.vertexCount,
      triangles: source.triangleCount
    },
    package: pkg.manifest,
    section: {
      type: section.type,
      byteOffset: section.byteOffset,
      byteLength: section.byteLength,
      alignment: section.alignment
    },
    corruptionIssues: corruption.issues.map((issue) => issue.code)
  };
  status.textContent = artifact.passed ? "验证通过" : "验证失败";
  status.className = artifact.passed ? "ok" : "error";
  summary.innerHTML = artifact.passed
    ? `<strong>PASS</strong>：${source.vertexCount} vertices / ${source.triangleCount} triangles，package ${bytes.byteLength} bytes。`
    : "Package 或 corruption Gate 未通过。";
  result.textContent = JSON.stringify(artifact, null, 2);
  if (!artifact.passed) throw new Error("R2-A Package Kernel browser validation failed");
}

function requiredElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (element === null) throw new Error(`Missing #${id}`);
  return element as T;
}
