/** Local diagnostic integration: same owner/cache/layout/source, async creation.
 * No production import, no shader or optimizer change, no GPU work submission.
 */
function unique(source, seam) {
  const at = source.indexOf(seam);
  if (at < 0 || source.indexOf(seam, at + 1) >= 0) throw new Error(`Missing/ambiguous async prewarm seam: ${seam}`);
  return at;
}
export function prewarmSurfaceOwner(source) {
  const begin = unique(source, "  private program(");
  const end = unique(source, "  private resolveBinding(");
  if (end <= begin) throw new Error("Unexpected Surface owner method order");
  const method = source.slice(begin, end);
  unique(method, "): Program {");
  unique(method, "this.device.createComputePipeline(");
  const asyncMethod = method.replace("private program(", "async diagnosticPrewarmProgram(")
    .replace("): Program {", "): Promise<Program> {")
    .replace("this.device.createComputePipeline(", "await this.device.createComputePipelineAsync(");
  const cacheSeam = "const cached = this.programs.get(key); if (cached) return cached;";
  unique(method, cacheSeam);
  const synchronousMethod = method.replace(cacheSeam, `const cached = this.programs.get(key);
    const diagnostic = (globalThis as unknown as { __surfaceDiagnostic?: { prewarmCacheHits: string[]; prewarmCacheMisses: string[] } }).__surfaceDiagnostic;
    if (cached) { diagnostic?.prewarmCacheHits.push(key); return cached; }
    diagnostic?.prewarmCacheMisses.push(key);`);
  return source.slice(0, begin) + asyncMethod + synchronousMethod + source.slice(end);
}
export function prewarmRendererRoot(source) {
  const at = unique(source, "  render(camera: PerspectiveCamera, scene: Scene,");
  // Closed Dungeon diagnostic profile. Actual program() cache misses are logged.
  const method = `  async diagnosticPrewarmSurface(): Promise<void> {
    for (const mask of [12]) for (const closure of [false, true]) {
      console.info('SURFACE_CAPTURE async compile mask=' + mask + ' closure=' + closure);
      await this._surfaceMaterial.diagnosticPrewarmProgram(true, true, 4, mask, true, true, false, closure);
    }
  }
`;
  return source.slice(0, at) + method + source.slice(at);
}
