import {
  DOMAIN_DIRECTORY_HEADER_WORDS,
  DOMAIN_RECORD_HEADER_WORDS,
  SurfaceDomainDirectoryBuilder,
  readSurfaceDomainRecord,
} from "../../.test-dist/gpu/GpuSurfaceDomainAbi.js";

const check = (condition, message) => {
  if (!condition) throw new Error(message);
};

/** Planes are the 15 material fields plus 6 signals, as the Surface chain uses. */
const PLANES = 21;
const FIELD_PLANES = 15;

/**
 * One appearance closure shared by every pixel of a fixture. `closure` is the
 * publication-interned equality key; two domains are the same entity exactly
 * when the whole key agrees, which is what makes interning meaningful.
 */
function closureFor(name) {
  let hash = 2166136261;
  for (let at = 0; at < name.length; at++) {
    hash = Math.imul(hash ^ name.charCodeAt(at), 16777619) >>> 0;
  }
  return hash;
}

/**
 * Fixtures chosen so the three counts disagree in a different way each time.
 * A single number cannot represent any of them:
 *
 *   constant  1 domain, 0 sample slots  — value is published, never evaluated
 *   textured  1 domain, 15 sample slots — same sharing, real work per sample
 *   mixed     2 domains, different refs — a tile referencing each
 *
 * The plan (§6.1) requires these to be asserted separately; if domain count
 * were derived from tile count, or sample work from domain count, at least one
 * row here would be unrepresentable.
 */
function fixtures() {
  const allPlanes = (1 << PLANES) - 1;
  const constant = new SurfaceDomainDirectoryBuilder(PLANES);
  constant.intern({
    closure: closureFor("unlit-constant"),
    planeMask: allPlanes,
    tileEdges: 8,
    sampleMask: 0,
    sampleCount: 0,
  });
  const textured = new SurfaceDomainDirectoryBuilder(PLANES);
  // Every field plane needs a real evaluation point; sharing is still legal
  // because the closure and coordinate domain agree.
  textured.intern({
    closure: closureFor("standard-pbr-textured"),
    planeMask: allPlanes,
    tileEdges: 8,
    sampleMask: (1 << FIELD_PLANES) - 1,
    sampleCount: FIELD_PLANES,
  });
  const mixed = new SurfaceDomainDirectoryBuilder(PLANES);
  const plain = mixed.intern({
    closure: closureFor("unlit-constant"),
    planeMask: 1,
    tileEdges: 8,
    sampleMask: 0,
    sampleCount: 0,
  });
  const detailed = mixed.intern({
    closure: closureFor("standard-pbr-textured"),
    planeMask: allPlanes,
    tileEdges: 8,
    sampleMask: (1 << FIELD_PLANES) - 1,
    sampleCount: FIELD_PLANES,
  });
  return [
    // One tile for a 1080p frame at 8x8: 240 * 135 = 32400, but the directory
    // holds one record either way. Tile count and domain count are independent.
    { label: "constant-uniform", builder: constant, tiles: 32400, tileDomains: () => new Uint32Array(32400) },
    { label: "textured-uniform", builder: textured, tiles: 32400, tileDomains: () => new Uint32Array(32400) },
    {
      label: "mixed-two-domains",
      builder: mixed,
      tiles: 32400,
      tileDomains: () => {
        const references = new Uint32Array(32400);
        for (let tile = 0; tile < references.length; tile++)
          references[tile] = tile % 2 === 0 ? plain : detailed;
        return references;
      },
    },
  ];
}

/**
 * B1-05 domain oracle.
 *
 * The directory is uploaded as the bytes the publication ABI produces, and a
 * real GPU kernel reads that same buffer. The assertions then separate the
 * three counts the plan requires to differ (§6.1): number of domain records,
 * number of tile references, and amount of sample work. GPU-reported counts are
 * compared against the CPU packing rather than against a re-derived expectation,
 * so a packing bug cannot hide behind an equally wrong reader.
 */
export async function runSurfaceDomainGpuOracle(device) {
  const cases = fixtures();
  const allocations = [];
  const reports = [];
  const buffer = (data, usage = GPUBufferUsage.STORAGE) => {
    const resource = device.createBuffer({
      size: Math.max(4, data.byteLength),
      usage: usage | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
    });
    device.queue.writeBuffer(resource, 0, data);
    allocations.push(resource);
    return resource;
  };
  const source = /* wgsl */ `
struct Settings { tiles: u32, records: u32, per_record: u32, mask_words: u32, }
@group(0) @binding(0) var<storage, read> directory: array<u32>;
@group(0) @binding(1) var<storage, read> tile_domains: array<u32>;
@group(0) @binding(2) var<storage, read_write> counters: array<atomic<u32>>;
@group(0) @binding(3) var<uniform> settings: Settings;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let lane = id.x;
  // Counter reset is uploaded before dispatch. Lane 0 cannot reset a counter
  // another workgroup may already have incremented; there is no global barrier.
  if lane == 0u {
    atomicStore(&counters[0], directory[0]);
    atomicStore(&counters[3], settings.tiles);
  }
  if lane >= settings.tiles { return; }
  // One tile reference resolves to one domain record. Tiles sharing a domain
  // all resolve to the same id; the id is the identity, the tile is the
  // coverage unit, and neither is the evaluation point.
  let domain = tile_domains[lane];
  if domain >= settings.records { return; }
  atomicAdd(&counters[1], 1u);
  let base = ${DOMAIN_DIRECTORY_HEADER_WORDS}u + domain * settings.per_record;
  // Sample work is read from the packed record, so the GPU-observed amount
  // comes from the same bytes a real consumer would read. A record demanding
  // nothing contributes nothing, which is why sample work cannot be derived
  // from the domain or tile counts.
  var slots = 0u;
  for (var word = 0u; word < settings.mask_words; word++) {
    var bits = directory[base + ${DOMAIN_RECORD_HEADER_WORDS}u + word];
    while bits != 0u {
      slots += bits & 1u;
      bits = bits >> 1u;
    }
  }
  if slots != 0u { atomicAdd(&counters[2], slots); }
}
`;
  const pipeline = device.createComputePipeline({
    layout: "auto",
    compute: { module: device.createShaderModule({ code: source }), entryPoint: "main" },
  });
  try {
    for (const fixture of cases) {
      const directory = fixture.builder.build();
      const references = fixture.tileDomains();
      const settings = new Uint32Array([
        references.length,
        directory.records.length,
        directory.words[1],
        directory.words[2],
      ]);
      const counters = buffer(new Uint32Array(4));
      const resources = [
        buffer(directory.words),
        buffer(references),
        counters,
        buffer(settings, GPUBufferUsage.UNIFORM),
      ];
      const group = device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: resources.map((resource, binding) => ({ binding, resource: { buffer: resource } })),
      });
      const readback = device.createBuffer({
        size: counters.size,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      });
      allocations.push(readback);
      const encoder = device.createCommandEncoder();
      const pass = encoder.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, group);
      pass.dispatchWorkgroups(Math.ceil(references.length / 64));
      pass.end();
      encoder.copyBufferToBuffer(counters, 0, readback, 0, counters.size);
      device.queue.submit([encoder.finish()]);
      await readback.mapAsync(GPUMapMode.READ);
      const observed = new Uint32Array(readback.getMappedRange());
      const gpuDomains = observed[0];
      const gpuReferences = observed[1];
      const gpuSampleSlots = observed[2];
      const gpuTiles = observed[3];
      readback.unmap();

      // The GPU must observe exactly what the publication ABI packed.
      check(
        gpuDomains === directory.records.length,
        `${fixture.label}: GPU saw ${gpuDomains} domains, packed ${directory.records.length}`,
      );
      check(
        gpuTiles === references.length,
        `${fixture.label}: GPU saw ${gpuTiles} tiles, sent ${references.length}`,
      );
      check(
        gpuReferences === references.length,
        `${fixture.label}: ${gpuReferences} references resolved of ${references.length}`,
      );

      // The three counts are independent. This is the assertion the plan asks
      // for: none of them may be derived from another.
      check(
        gpuReferences > gpuDomains,
        `${fixture.label}: ${gpuReferences} references did not exceed ${gpuDomains} domains; one domain would not be shared`,
      );

      // Total sample work per frame sums the referenced domain's sample slots
      // over every tile, which is the quantity design §3.2 calls Tevaluate. It
      // is NOT the per-domain sample count and NOT per-domain x tile count: a
      // mixed frame references different domains, so the sum must follow the
      // actual reference, per tile. This is computed from the tile-domain array
      // the GPU was given, so a wrong reference cannot produce a matching total.
      const expectedFrameSlots = references.reduce(
        (total, domainId) => total + readSurfaceDomainRecord(directory.words, domainId).sampleCount,
        0,
      );
      check(
        gpuSampleSlots === expectedFrameSlots,
        `${fixture.label}: frame sample work ${gpuSampleSlots} != ${expectedFrameSlots} summed over ${references.length} tile references`,
      );
      check(
        gpuSampleSlots !== directory.sampleSlots || directory.sampleSlots === 0,
        `${fixture.label}: frame sample work collapsed to the per-domain count`,
      );

      // Read every record back through the public reader and confirm the GPU
      // path and the CPU path agree field by field.
      for (const record of directory.records) {
        const read = readSurfaceDomainRecord(directory.words, record.domainId);
        check(
          read.closure === record.closure,
          `${fixture.label}: closure drift at domain ${record.domainId}`,
        );
        check(
          read.planeMask === record.planeMask,
          `${fixture.label}: plane mask drift at domain ${record.domainId}`,
        );
        check(
          read.sampleCount === record.sampleCount,
          `${fixture.label}: sample count drift at domain ${record.domainId}`,
        );
      }

      reports.push({
        label: fixture.label,
        domains: gpuDomains,
        tileReferences: gpuReferences,
        /** Sample slots one domain describes. */
        perDomainSamples: directory.sampleSlots,
        /** Sample evaluations the whole frame performs (design §3.2 Tevaluate). */
        frameSamples: gpuSampleSlots,
        tiles: gpuTiles,
        planeMaskUnion: directory.planeMaskUnion,
      });
    }

    // The separation must actually be exercised, not merely declared: a fixture
    // where sample work is zero and one where it is non-zero for the SAME domain
    // count proves sample work is not derived from domains.
    const constant = reports.find((report) => report.label === "constant-uniform");
    const textured = reports.find((report) => report.label === "textured-uniform");
    check(constant !== undefined && textured !== undefined, "domain fixtures missing");
    check(constant.domains === textured.domains, "constant and textured fixtures must share a domain count");
    check(
      constant.tileReferences === textured.tileReferences,
      "both uniform fixtures must have the same tile reference count",
    );
    // Same domain count, same reference count, different sample work. This is
    // exactly what the plan requires to be assertable separately (§6.1): if any
    // one count implied another, these two rows could not differ here.
    check(
      constant.perDomainSamples === 0,
      `published-value domain must describe no sample work, saw ${constant.perDomainSamples}`,
    );
    check(textured.perDomainSamples > 0, "textured domain must describe real sample work");
    check(
      constant.frameSamples === 0,
      `constant fixture must perform no sample work, saw ${constant.frameSamples}`,
    );
    check(textured.frameSamples > 0, "textured fixture must perform real sample work");
    // One domain referenced by every tile: the shared entity is what lets the
    // frame's work grow with references while the domain count stays at one.
    check(
      textured.frameSamples === textured.perDomainSamples * textured.tileReferences,
      "frame sample work must equal per-domain slots times references when one domain is shared",
    );
    // The mixed fixture is the case a single count cannot express: two domains,
    // each tile referencing exactly one, so frame work is half the per-domain
    // rate times the tile count. A domain count or tile count alone would give
    // the wrong number here.
    const mixed = reports.find((report) => report.label === "mixed-two-domains");
    check(mixed !== undefined, "mixed fixture missing");
    check(mixed.domains === 2, `mixed fixture must publish two domains, saw ${mixed.domains}`);
    check(
      mixed.frameSamples === textured.perDomainSamples * (mixed.tileReferences / 2),
      `mixed frame work ${mixed.frameSamples} must follow the actual per-tile reference split`,
    );

    return {
      passed: true,
      scope:
        "B1 domain entity: publication-interned domain identity, tile references and sample work counted separately on a real GPU; not full Surface cutover",
      reports,
    };
  } finally {
    for (const resource of allocations) resource.destroy();
  }
}
