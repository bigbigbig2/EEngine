import type { TiledTextureSource } from "../assets/TiledTextureSource.js";
import type { TiledTexturePayloadLease } from "../assets/codec/CookedAssetPreparation.js";
import type { ShadeGPUCommandContext } from "../framegraph/ShadeGPUCommandContext.js";
import type { GraphicsContext } from "./GraphicsContext.js";
import {
  MeshletRangeAllocator,
  type MeshletRangeAllocation,
  INVALID_MESHLET_ALLOCATION
} from "./MeshletRangeAllocator.js";
import {
  virtualTextureSettings,
  VT_ATLAS_SIZE,
  VT_PAGE_CAPACITY,
  VT_TABLE_WIDTH,
  VT_MISSING,
  type VirtualTextureSettings,
  type VirtualTextureRoute,
  type VirtualTextureMipRoute
} from "./VirtualTextureAbi.js";
import { VirtualTextureFeedback, type VirtualTextureObservation } from "./VirtualTextureFeedback.js";
import type { ResourceHandle } from "../debug/profiling/ResourceAccounting.js";

interface Pool {
  readonly texture: GPUTexture;
  readonly view: GPUTextureView;
  readonly free: number[];
  readonly generations: Uint32Array;
  readonly owners: Map<number, Page>;
  readonly bytes: number;
  pinned: number;
}
interface Source {
  readonly source: TiledTextureSource;
  readonly generation: number;
  readonly allocation: MeshletRangeAllocation;
  readonly pages: readonly Page[];
  readonly routes: ReadonlyMap<number, VirtualTextureRoute>;
  readonly cpuBytes: number;
  live: boolean;
  bootstrap: Promise<void> | null;
}
interface Batch {
  readonly controller: AbortController;
  readonly pages: Page[];
  lease: TiledTexturePayloadLease | null;
  remaining: number;
}
interface Page {
  readonly id: number;
  readonly payload: number;
  readonly source: Source;
  readonly profile: number;
  readonly level: number;
  readonly x: number;
  readonly y: number;
  readonly pool: Pool;
  readonly pinned: boolean;
  readonly parents: number[];
  refs: number;
  slot: number;
  generation: number;
  lastUsed: number;
  pending?: Batch;
  ready?: ArrayBuffer;
  attempts: number;
  reserved?: { slot: number; generation: number };
  everResident: boolean;
}
interface Upload {
  readonly page: Page;
  readonly slot: number;
  readonly generation: number;
  readonly victim?: Page;
}

/** Intel 714e144d (MIT), StreamingResourceBase::{SetMinMip,AddTileRef,
 * DecTileRef,ProcessFeedback,AbandonPendingLoads,QueuePendingTileEvictions}
 * and EvictionDelay::Rescue adapted to WebGPU's one queue and software atlas.
 * Desired references, pending loads, physical residency and delayed eviction
 * remain distinct. NPOT parents are exact normalized-coverage intersections.
 * Source and notices: tests/oracle/reference/vt/. No hardware sparse mappings. */
export class VirtualTextureResidency {
  readonly settings: VirtualTextureSettings;
  readonly table: GPUTexture;
  readonly tableView: GPUTextureView;
  readonly feedback: VirtualTextureFeedback<readonly (Page | undefined)[]>;
  readonly ready: Promise<void>;
  private readonly allocator = new MeshletRangeAllocator(VT_PAGE_CAPACITY, 8192);
  private readonly sources = new Map<TiledTextureSource, Source>();
  private readonly pools = new Map<GPUTextureFormat, Pool>();
  private snapshot: (Page | undefined)[] = [];
  private snapshotShared = false;
  private routeBytes = 0;
  private cpuBytes = 0;
  private readonly desired = new Set<Page>();
  private readonly admitted = new Set<Page>();
  private readonly resident = new Set<Page>();
  private readonly readyPages = new Set<Page>();
  private readonly batches = new Set<Batch>();
  private generation = 0;
  private stopped = false;
  private lastFrame = -1;
  private view = 0;
  private viewKey = "";
  private observedFrame = -1;
  private observedView = -1;
  private lastPublication = -1;
  private uploadedBytes = 0;
  private physicalCopyBytes = 0;
  private stagingBytes = 0;
  private stagingPeak = 0;
  private residencyRevision = 1;
  private evictions = 0;
  private reloads = 0;
  private rescued = 0;
  private limited = false;
  private failure: string | null = null;
  private feedbackBuffer: GPUBuffer;
  private encoded: ShadeGPUCommandContext | null = null;
  private readonly accounting: ResourceHandle[] = [];
  private lastDemand = { wanted: 0, used: 0, missing: 0, targetMip: [-1, -1], actualMip: [-1, -1] };
  private receiptBytes = 0;
  private pumpDirty = true;
  private queryFeedback: VirtualTextureFeedback<readonly (Page | undefined)[]> | null = null;
  private queryFeedbackCommand: ShadeGPUCommandContext | null = null;
  private queryFeedbackBuffer: GPUBuffer | null = null;
  private queryObservedFrame = -1;
  private queryUsers = 0;
  private readonly primaryDemand = new Map<Page, number>();
  private readonly queryDemand = new Map<Page, number>();
  private queryCursor = 0;
  private queryGrantEpoch = -1;
  private readonly queryGrants = new Set<Page>();
  private readonly lastQueryGrant = new Map<Page, number>();
  private mappingCandidate: { command: ShadeGPUCommandContext; generation: number } | null = null;

  constructor(
    private readonly graphics: GraphicsContext,
    settings?: Partial<VirtualTextureSettings>
  ) {
    this.settings = virtualTextureSettings(settings);
    const device = graphics.device;
    if (
      !device.features.has("texture-compression-bc") ||
      device.limits.maxTextureDimension2D < VT_ATLAS_SIZE ||
      device.limits.maxStorageBuffersPerShaderStage < 16 ||
      this.settings.metadataBytes < VT_PAGE_CAPACITY * 8
    ) {
      throw new RangeError("VT requires BC, a 2304px atlas, 16 storage bindings and complete page metadata");
    }
    this.table = device.createTexture({
      label: "VT/integer page table",
      size: [VT_TABLE_WIDTH, VT_PAGE_CAPACITY / VT_TABLE_WIDTH, 1],
      format: "rg32uint",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST
    });
    this.tableView = this.table.createView({ dimension: "2d-array" });
    this.account(this.table, VT_PAGE_CAPACITY * 8);
    // New, unpublished object only. Later validity changes are encoder copies.
    const initial = new Uint32Array(VT_PAGE_CAPACITY * 2);
    for (let i = 0; i < VT_PAGE_CAPACITY; i++) initial[i * 2] = VT_MISSING;
    device.queue.writeTexture(
      { texture: this.table },
      initial,
      { bytesPerRow: VT_TABLE_WIDTH * 8, rowsPerImage: VT_PAGE_CAPACITY / VT_TABLE_WIDTH },
      [VT_TABLE_WIDTH, VT_PAGE_CAPACITY / VT_TABLE_WIDTH, 1]
    );
    this.feedback = new VirtualTextureFeedback(
      device,
      (observation) => this.observe(observation),
      (error) => this.fail(error),
      graphics.resource_accounting
    );
    this.feedbackBuffer = this.feedback.disabled;
    this.ready = this.feedback.ready;
    void device.lost.then(() => this.destroy());
  }
  get sourceCount(): number {
    return this.sources.size;
  }
  private account(texture: GPUTexture, bytes: number): void {
    const handle = this.graphics.resource_accounting?.created(
      {
        kind: "texture",
        category: "resident",
        owner: "VirtualTextureResidency",
        bytes,
        label: texture.label
      },
      texture
    );
    if (handle) {
      this.accounting.push(handle);
    }
  }

  /** Cold source publication. Every profile has independent border identity;
   * the allocator provides contiguous mip domains without truncating IDs. */
  stage(
    source: TiledTextureSource,
    command: ShadeGPUCommandContext
  ): ReadonlyMap<number, VirtualTextureRoute> {
    const known = this.sources.get(source);
    if (known) return known.routes;
    const profiles = source.directory.metadata.planes;
    const count = profiles.reduce(
      (n, p) =>
        n +
        (p.mode === "virtual"
          ? p.mips.slice(0, p.tailFirst).reduce((s, mip) => s + mip.payloads.length, 0) + 1
          : 0),
      0
    );
    const routeBytes = profiles.reduce((n, p) => n + (p.mode === "virtual" ? p.mips.length * 7 * 4 : 0), 0);
    // Include records, parent arrays, membership sets and in-flight snapshots.
    // Directory parsing is separately admitted by the provider.
    const cpuBytes = profiles.reduce(
      (bytes, profile) =>
        bytes +
        (profile.mode === "virtual"
          ? profile.mips
              .slice(0, profile.tailFirst)
              .reduce(
                (sum, mip) => sum + mip.payloads.length * (320 + 32 * (profile.tailFirst - mip.level)),
                320
              )
          : 0),
      routeBytes * 4
    );
    if (
      this.stopped ||
      count < 1 ||
      this.generation >= 0xffffffff ||
      VT_PAGE_CAPACITY * 8 + this.routeBytes + routeBytes > this.settings.metadataBytes ||
      this.cpuBytes + cpuBytes > 128 * 1024 ** 2
    ) {
      throw new RangeError("VT source/metadata identity capacity exceeded");
    }
    const allocation = this.allocator.allocate(count);
    if (allocation.offset === INVALID_MESHLET_ALLOCATION)
      throw new RangeError("VT virtual page capacity exhausted");
    const pages: Page[] = [];
    const routes = new Map<number, VirtualTextureRoute>();
    const record: Source = {
      source,
      generation: ++this.generation,
      allocation,
      pages,
      routes,
      cpuBytes,
      live: true,
      bootstrap: null
    };
    let next = allocation.offset;
    try {
      for (const [index, profile] of profiles.entries()) {
        if (profile.mode !== "virtual") continue;
        const pool = this.pool(source.metadata.planes[profile.sourcePlane]!.format);
        const mips: VirtualTextureMipRoute[] = [];
        let tail = -1;
        for (const mip of profile.mips) {
          if (mip.level >= profile.tailFirst && tail >= 0) {
            mips.push({
              width: mip.width,
              height: mip.height,
              gridWidth: 1,
              base: tail,
              origin: mip.tailOrigin!
            });
            continue;
          }
          const base = next;
          const pinned = mip.level === profile.tailFirst;
          if (pinned) tail = base;
          for (const [tile, payload] of mip.payloads.entries()) {
            const page: Page = {
              id: next++,
              payload,
              source: record,
              profile: index,
              level: mip.level,
              x: tile % mip.gridWidth,
              y: Math.floor(tile / mip.gridWidth),
              pool,
              pinned,
              parents: [],
              refs: 0,
              slot: VT_MISSING,
              generation: 0,
              lastUsed: -1,
              attempts: 0,
              everResident: false
            };
            pages.push(page);
          }
          mips.push({
            width: mip.width,
            height: mip.height,
            gridWidth: mip.gridWidth,
            base,
            origin: mip.tailOrigin ?? [0, 0]
          });
        }
        routes.set(
          index,
          Object.freeze({
            table: this.table,
            tableView: this.tableView,
            atlas: pool.texture,
            atlasView: pool.view,
            tailFirst: profile.tailFirst,
            mips: Object.freeze(mips)
          })
        );
      }
      for (const page of pages) {
        if (page.pinned) continue;
        const route = routes.get(page.profile)!;
        const fine = route.mips[page.level]!;
        // A fine NPOT tile can overlap several coarse tiles. Keep every
        // intersected parent, not simply x/y >> 1.
        for (let level = page.level + 1; level <= route.tailFirst; level++) {
          const coarse = route.mips[level]!;
          if (level === route.tailFirst) {
            page.parents.push(coarse.base);
            continue;
          }
          const x0 = Math.floor((((page.x * 128) / fine.width) * coarse.width) / 128);
          const y0 = Math.floor((((page.y * 128) / fine.height) * coarse.height) / 128);
          const x1 = Math.min(
            coarse.gridWidth,
            Math.ceil(((Math.min((page.x + 1) * 128, fine.width) / fine.width) * coarse.width) / 128)
          );
          const y1 = Math.min(
            Math.ceil(coarse.height / 128),
            Math.ceil(((Math.min((page.y + 1) * 128, fine.height) / fine.height) * coarse.height) / 128)
          );
          for (let y = y0; y < y1; y++)
            for (let x = x0; x < x1; x++) {
              page.parents.push(coarse.base + y * coarse.gridWidth + x);
            }
        }
      }
      // Reserve all pinned slots before initiating IO.
      for (const page of pages) {
        if (!page.pinned) {
          continue;
        }
        const slot = page.pool.free.pop();
        if (slot === undefined) {
          throw new RangeError("VT protected tails exceed physical pool capacity");
        }
        page.reserved = { slot, generation: 0 };
        page.reserved.generation = this.nextGeneration(page.pool, slot);
      }
      this.invalidateRange(allocation.offset, count, command);
      this.sources.set(source, record);
      this.writeSnapshot();
      for (const page of pages) {
        this.snapshot[page.id] = page;
        if (page.pinned) {
          page.pool.pinned++;
        }
      }
      this.routeBytes += routeBytes;
      this.cpuBytes += cpuBytes;
      command.onAborted.addOne(() => this.remove(record));
      return routes;
    } catch (error) {
      for (const page of pages) {
        if (page.reserved) {
          page.pool.free.push(page.reserved.slot);
        }
      }
      this.allocator.free(allocation);
      throw error;
    }
  }

  private writeSnapshot(): void {
    // Copy only when a frame has actually retained this identity domain. Cold
    // staging of hundreds of sources must not copy the growing page array for
    // every texture. Delayed observations keep their original page objects.
    if (this.snapshotShared) {
      this.snapshot = this.snapshot.slice();
      this.snapshotShared = false;
    }
  }

  async bootstrap(
    source: TiledTextureSource,
    command: ShadeGPUCommandContext,
    signal?: AbortSignal
  ): Promise<void> {
    const record = this.sources.get(source);
    if (!record) return;
    if (record.bootstrap) return record.bootstrap;
    record.bootstrap = (async () => {
      await this.ready;
      const abort = new AbortController();
      command.onAborted.addOne(() => abort.abort());
      const combined = signal ? AbortSignal.any([abort.signal, signal]) : abort.signal;
      for (const page of record.pages) {
        if (!page.pinned) continue;
        const { slot, generation } = page.reserved!;
        const lease = await source.read([page.payload], combined, 0);
        try {
          if (!record.live || command.closed || this.stopped) throw new Error("VT bootstrap was cancelled");
          this.copyTile(page, slot, lease.payloads[0]!.bytes, command);
          this.copyMapping(page.id, slot, generation, command);
          command.onFinished.addOne(() => {
            page.reserved = undefined;
            this.publish({ page, slot, generation }, -1);
          });
        } finally {
          lease.release();
        }
      }
    })();
    return record.bootstrap;
  }

  /** Called before graph execution. The graph imports these exact objects and
   * encodes upload -> Surface -> feedback on its normal command transaction. */
  prepareFrame(command: ShadeGPUCommandContext, frame: number, key: string): void {
    if (this.failure) throw new Error(this.failure);
    if (this.encoded || this.stopped) throw new Error("VT has an unfinished frame");
    if (key !== this.viewKey) {
      this.viewKey = key;
      this.view++;
      this.limited = false;
    }
    this.encoded = command;
    this.lastFrame = frame;
    this.snapshotShared = true;
    this.feedbackBuffer = this.feedback.begin(command, frame, this.view, this.snapshot, this.snapshot.length);
    command.onAborted.addOne(() => {
      this.encoded = null;
    });
    command.onFinished.addOne(() => {
      this.encoded = null;
    });
    this.pump();
  }
  get frameFeedback(): GPUBuffer {
    return this.feedbackBuffer;
  }
  /** Prepared only when an actual query material samples VT. It uses the
   * existing IO/atlas owner, with a separate delayed demand channel. */
  async enableQueryFeedback(): Promise<void> {
    if (this.stopped) {
      throw new Error("VT owner is stopped");
    }
    this.queryFeedback ??= new VirtualTextureFeedback(
      this.graphics.device,
      (value) => this.observe(value, true),
      (error) => this.fail(error),
      this.graphics.resource_accounting
    );
    await this.queryFeedback.ready;
  }

  /** A prepared batch holds demand through its final consumer fence. Keep the
   * small feedback ring for binding reuse, but release query-only residency
   * when the last batch retires. Late feedback cannot revive retired demand. */
  retainQueryDemand(): () => void {
    if (this.stopped || this.queryFeedback === null) {
      throw new Error("Query demand requires the prepared live feedback channel");
    }
    this.queryUsers++;
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      this.queryUsers--;
      if (this.stopped || this.queryUsers !== 0) {
        return;
      }
      this.queryObservedFrame = Math.max(this.queryObservedFrame, this.lastFrame);
      this.queryDemand.clear();
      this.queryGrants.clear();
      this.lastQueryGrant.clear();
      this.reconcileDemand();
    };
  }

  get queryFeedbackBuffers(): readonly GPUBuffer[] {
    if (this.queryFeedback === null) {
      throw new Error("Prepare query feedback before creating bindings");
    }
    return this.queryFeedback.gpuBuffers;
  }

  beginQueryFeedback(command: ShadeGPUCommandContext): GPUBuffer {
    if (this.stopped || this.encoded !== command || this.queryFeedback === null) {
      throw new Error("Query VT feedback requires the prepared ordinary VT frame and ready query channel");
    }
    if (this.queryFeedbackCommand !== null) {
      if (this.queryFeedbackCommand !== command) {
        throw new Error("Query VT feedback belongs to another command");
      }
      return this.queryFeedbackBuffer!;
    }
    this.queryFeedbackCommand = command;
    this.queryFeedbackBuffer = this.queryFeedback.begin(
      command,
      this.lastFrame,
      this.view,
      this.snapshot,
      this.snapshot.length
    );
    command.onAborted.addOne(() => {
      this.queryFeedbackCommand = null;
    });
    command.onFinished.addOne(() => {
      this.queryFeedbackCommand = null;
    });
    return this.queryFeedbackBuffer;
  }

  /** Conservative batch-wide invalidation token. A finer mip/mapping change
   * changes this generation even if material constants remain unchanged.
   * Candidate generation is readable in its upload command; abort rolls back. */
  mappingGeneration(command?: ShadeGPUCommandContext): number {
    return this.mappingCandidate !== null && this.mappingCandidate.command === command
      ? this.mappingCandidate.generation
      : this.residencyRevision;
  }
  get resources(): readonly GPUTexture[] {
    return [this.table, ...[...this.pools.values()].map((pool) => pool.texture)];
  }

  encodeUploads(command: ShadeGPUCommandContext): void {
    if (this.encoded !== command) throw new Error("VT upload belongs to another frame");
    if (this.readyPages.size === 0) {
      return;
    }
    const selected: Upload[] = [];
    // Install rollback before reserving slots or encoding any copy. A staging
    // allocation/copy failure midway through the loop must still be abortable.
    command.onAborted.addOne(() => {
      for (const upload of selected) if (!upload.victim) upload.page.pool.free.push(upload.slot);
    });
    const victims = new Map<Pool, Page[]>();
    const coldCandidates = (pool: Pool): Page[] => {
      const prior = victims.get(pool);
      if (prior) {
        return prior;
      }
      const candidates: Page[] = [];
      for (const page of pool.owners.values()) {
        if (this.canEvict(page)) {
          candidates.push(page);
        }
      }
      candidates.sort((a, b) => b.lastUsed - a.lastUsed);
      victims.set(pool, candidates);
      return candidates;
    };
    let bytes = 0;
    for (const page of this.readyPages) {
      if (!page.source.live || !this.admitted.has(page)) {
        this.discard(page);
        continue;
      }
      const rowBytes = page.pool.texture.format === "bc4-r-unorm" ? 36 * 8 : 36 * 16;
      // Include both a possible victim invalidation and the new publication.
      const cost = Math.ceil(rowBytes / 256) * 256 * 36 + 512;
      if (
        selected.length >= Math.floor(this.settings.copies / 3) ||
        bytes + cost > this.settings.uploadBytes ||
        this.stagingBytes + cost > 16 * 1024 ** 2
      )
        break;
      let slot = page.pool.free.pop();
      let victim: Page | undefined;
      if (slot === undefined) {
        // Desired pages and recent usage are protected. Queue order ensures all
        // prior GPU readers precede invalidation/overwrite in this command.
        victim = coldCandidates(page.pool).pop();
        if (!victim) {
          this.limited = true;
          continue;
        }
        slot = victim.slot;
      }
      const upload = { page, slot, generation: 0, victim };
      selected.push(upload);
      const generation = this.nextGeneration(page.pool, slot);
      upload.generation = generation;
      bytes += cost;
      if (victim) this.copyMapping(victim.id, VT_MISSING, 0, command);
      this.copyTile(page, slot, page.ready!, command);
      this.copyMapping(page.id, slot, generation, command);
    }
    if (selected.length !== 0) {
      if (this.residencyRevision >= 0xfffffffe) {
        throw new RangeError("VT mapping generation exhausted; retire the owner before reuse");
      }
      this.mappingCandidate = { command, generation: this.residencyRevision + 1 };
      command.onAborted.addOne(() => {
        this.mappingCandidate = null;
      });
    }
    command.onFinished.addOne(() => {
      for (const upload of selected) {
        if (upload.victim) {
          upload.victim.slot = VT_MISSING;
          upload.victim.generation = 0;
          this.resident.delete(upload.victim);
          this.evictions++;
        }
        this.publish(upload, this.lastFrame);
        this.discard(upload.page);
      }
      if (selected.length) {
        this.lastPublication = this.lastFrame;
        this.residencyRevision++;
        this.mappingCandidate = null;
      }
      this.pump();
    });
  }
  finishFeedback(command: ShadeGPUCommandContext): void {
    this.feedback.end(command);
    if (this.queryFeedbackCommand === command) {
      this.queryFeedback!.end(command);
    }
  }

  private publish(upload: Upload, frame: number): void {
    const { page, slot, generation } = upload;
    page.slot = slot;
    page.generation = generation;
    page.lastUsed = Math.max(page.lastUsed, frame);
    page.pool.owners.set(slot, page);
    this.resident.add(page);
    if (page.everResident) {
      this.reloads++;
    }
    page.everResident = true;
    page.attempts = 0;
  }
  private observe(value: VirtualTextureObservation<readonly (Page | undefined)[]>, query = false): void {
    if (this.stopped) return;
    for (const id of value.used) {
      const page = value.snapshot[id];
      if (page?.source.live) page.lastUsed = Math.max(page.lastUsed, value.frame);
    }
    if (value.frame <= (query ? this.queryObservedFrame : this.observedFrame) || value.view !== this.view)
      return;
    if (query) {
      this.queryObservedFrame = value.frame;
      this.queryCursor = (this.queryCursor + 1) % VT_PAGE_CAPACITY;
      const epoch = Math.floor(value.frame / 8);
      if (epoch !== this.queryGrantEpoch) {
        this.queryGrantEpoch = epoch;
        this.queryGrants.clear();
      }
    } else {
      this.observedFrame = value.frame;
      this.observedView = value.view;
    }
    const mipRange = (ids: readonly number[]) => {
      let min = Infinity,
        max = -1;
      for (const id of ids) {
        const page = value.snapshot[id];
        if (page?.source.live) {
          min = Math.min(min, page.level);
          max = Math.max(max, page.level);
        }
      }
      return [Number.isFinite(min) ? min : -1, max];
    };
    if (!query) {
      this.lastDemand = {
        wanted: value.wanted.length,
        used: value.used.length,
        missing: value.wanted.reduce((n, id) => n + (value.snapshot[id]?.slot === VT_MISSING ? 1 : 0), 0),
        targetMip: mipRange(value.wanted),
        actualMip: mipRange(value.used)
      };
    }
    const channel = query ? this.queryDemand : this.primaryDemand;
    channel.clear();
    for (const id of value.wanted) {
      const page = value.snapshot[id];
      if (!page?.source.live || this.snapshot[id] !== page) continue;
      channel.set(page, (channel.get(page) ?? 0) + 1);
      for (const parentId of page.parents) {
        const parent = value.snapshot[parentId]!;
        if (parent?.source.live && this.snapshot[parentId] === parent) {
          channel.set(parent, (channel.get(parent) ?? 0) + 1);
        }
      }
    }
    this.reconcileDemand();
  }

  private reconcileDemand(): void {
    const refs = new Map<Page, number>();
    for (const demand of [this.primaryDemand, this.queryDemand]) {
      for (const [page, count] of demand) {
        if (page.source.live && this.snapshot[page.id] === page) {
          refs.set(page, (refs.get(page) ?? 0) + count);
        }
      }
    }
    for (const page of this.desired) {
      if (!refs.has(page)) {
        page.refs = 0;
        this.desired.delete(page);
        this.discard(page);
      }
    }
    for (const [page, count] of refs) {
      if (page.refs === 0 && page.slot !== VT_MISSING) this.rescued++;
      page.refs = count;
      this.desired.add(page);
    }
    this.admitted.clear();
    const capacity = new Map<Pool, number>();
    for (const pool of this.pools.values()) {
      capacity.set(pool, pool.generations.length - pool.pinned);
    }
    const priority = [...this.desired]
      .filter((page) => !page.pinned)
      // Keep equal-mip resident/in-flight demand stable under pressure. TAA
      // boundary changes must not discard and re-read unpublished tiles.
      // Coarse dependencies still precede every finer page.
      .sort(
        (a, b) =>
          b.level - a.level ||
          Number(b.slot !== VT_MISSING) - Number(a.slot !== VT_MISSING) ||
          Number(!!b.pending) - Number(!!a.pending) ||
          ((a.id - this.queryCursor + VT_PAGE_CAPACITY) % VT_PAGE_CAPACITY) -
            ((b.id - this.queryCursor + VT_PAGE_CAPACITY) % VT_PAGE_CAPACITY)
      );
    const queryPriority = priority
      .filter((page) => this.queryDemand.has(page))
      .sort(
        (a, b) =>
          b.level - a.level ||
          Number(this.queryGrants.has(b)) - Number(this.queryGrants.has(a)) ||
          (this.lastQueryGrant.get(a) ?? -1) - (this.lastQueryGrant.get(b) ?? -1) ||
          a.id - b.id
      );
    this.limited = false;
    // Seven primary shares and one query share, with borrowing of unused
    // capacity. Coarse parents precede fine children inside each channel.
    // Query-only equal-mip demand rotates; newly visible demand cannot starve
    // all offscreen query pages indefinitely.
    for (const pool of this.pools.values()) {
      const total = capacity.get(pool)!;
      const queryReserve = this.queryDemand.size === 0 ? 0 : Math.max(1, Math.floor(total / 8));
      const admit = (matches: (page: Page) => boolean, quota: number, pages = priority): void => {
        for (const page of pages) {
          if (quota === 0 || capacity.get(pool) === 0) {
            break;
          }
          if (page.pool !== pool || this.admitted.has(page) || !matches(page)) {
            continue;
          }
          this.admitted.add(page);
          if (pages === queryPriority && !this.primaryDemand.has(page)) {
            this.queryGrants.add(page);
            this.lastQueryGrant.set(page, this.queryGrantEpoch);
          }
          capacity.set(pool, capacity.get(pool)! - 1);
          quota--;
        }
      };
      admit((page) => this.primaryDemand.has(page), Math.max(0, total - queryReserve));
      admit((page) => this.queryDemand.has(page), queryReserve, queryPriority);
      admit(() => true, total);
    }
    for (const page of priority) {
      if (!this.admitted.has(page)) {
        this.limited = true;
        this.discard(page);
      }
    }
    // Abandon only an entirely unwanted IO batch; retained pages rescue it.
    for (const batch of this.batches) {
      if (!batch.pages.some((page) => page.pending === batch && this.admitted.has(page) && page.source.live))
        batch.controller.abort();
    }
    this.pumpDirty = true;
    this.pump();
  }
  private pump(): void {
    if (this.stopped || this.failure || !this.pumpDirty || this.batches.size >= 4) {
      return;
    }
    this.pumpDirty = false;
    const pending = [...this.admitted]
      .filter(
        (page) => !page.pinned && page.source.live && page.slot === VT_MISSING && !page.pending && !page.ready
      )
      .sort((a, b) => b.level - a.level || a.id - b.id);
    if (pending.length === 0) {
      return;
    }
    // IO admission must have physical backing, including every retained lease.
    // A coarse fallback can be in use every frame even when no longer admitted
    // as a target. Reading its replacement before it is reclaimable only churns
    // authenticated leases as the feedback boundary moves under pressure.
    const available = new Map<Pool, number>();
    for (const pool of this.pools.values()) {
      let slots = pool.free.length;
      if (slots === 0) {
        for (const page of pool.owners.values()) {
          if (this.canEvict(page)) {
            slots++;
          }
        }
      }
      available.set(pool, slots);
    }
    for (const batch of this.batches) {
      for (const page of batch.pages) {
        if (page.pending === batch) {
          available.set(page.pool, available.get(page.pool)! - 1);
        }
      }
    }
    for (let index = 0; index < pending.length; ) {
      const page = pending[index]!;
      const slots = available.get(page.pool)!;
      if (slots <= 0) {
        pending.splice(index, 1);
      } else {
        available.set(page.pool, slots - 1);
        index++;
      }
    }
    while (this.batches.size < 4 && pending.length) {
      const first = pending.shift()!;
      const pages = [first];
      for (let i = 0; i < pending.length && pages.length < 32; ) {
        if (pending[i]!.source === first.source) pages.push(pending.splice(i, 1)[0]!);
        else i++;
      }
      const batch: Batch = { controller: new AbortController(), pages, lease: null, remaining: pages.length };
      this.batches.add(batch);
      for (const page of pages) page.pending = batch;
      void first.source.source
        .read(
          pages.map((page) => page.payload),
          batch.controller.signal
        )
        .then((lease) => {
          if (!this.batches.has(batch) || this.stopped || batch.controller.signal.aborted) {
            lease.release();
            for (const page of pages) {
              if (page.pending === batch) {
                this.discard(page);
              }
            }
            return;
          }
          batch.lease = lease;
          this.receiptBytes += lease.payloads.reduce((n, payload) => n + payload.bytes.byteLength, 0);
          for (const [index, page] of pages.entries()) {
            if (!page.source.live || !this.admitted.has(page) || page.pending !== batch) {
              if (page.pending === batch) {
                this.discard(page);
              }
            } else {
              page.ready = lease.payloads[index]!.bytes;
              this.readyPages.add(page);
            }
          }
        })
        .catch((error: unknown) => {
          for (const page of pages) {
            if (page.pending === batch) page.pending = undefined;
            if (!batch.controller.signal.aborted && page.source.live && ++page.attempts >= 3)
              this.fail(error);
          }
          this.batches.delete(batch);
          this.pumpDirty = true;
        });
    }
  }
  private canEvict(page: Page): boolean {
    return (
      !page.pinned &&
      !this.admitted.has(page) &&
      page.lastUsed < this.observedFrame - 2 &&
      this.observedView === this.view
    );
  }
  private discard(page: Page): void {
    const batch = page.pending;
    page.ready = undefined;
    page.pending = undefined;
    this.readyPages.delete(page);
    this.pumpDirty = true;
    if (batch && --batch.remaining === 0) {
      if (!batch.lease) {
        batch.controller.abort();
      }
      batch.lease?.release();
      this.batches.delete(batch);
    }
  }
  async release(source: TiledTextureSource, completion: Promise<void>): Promise<void> {
    const record = this.sources.get(source);
    if (!record) return;
    record.live = false;
    for (const batch of this.batches) {
      if (batch.pages[0]?.source === record) {
        batch.controller.abort();
      }
    }
    await completion;
    this.remove(record);
  }
  /** Caller has already awaited the last consumer fence. Synchronous removal
   * permits immediate reacquisition without returning a retiring source. */
  releaseCompleted(source: TiledTextureSource): void {
    const record = this.sources.get(source);
    if (record) {
      this.remove(record);
    }
  }
  private remove(record: Source): void {
    if (this.sources.get(record.source) !== record) return;
    record.live = false;
    for (const batch of this.batches) {
      if (batch.pages[0]?.source === record) {
        batch.controller.abort();
      }
    }
    for (const page of record.pages) {
      if (page.pinned) {
        page.pool.pinned--;
      }
      this.desired.delete(page);
      this.primaryDemand.delete(page);
      this.queryDemand.delete(page);
      this.queryGrants.delete(page);
      this.lastQueryGrant.delete(page);
      this.admitted.delete(page);
      this.discard(page);
      this.resident.delete(page);
      if (page.slot !== VT_MISSING) {
        page.pool.owners.delete(page.slot);
        page.pool.free.push(page.slot);
      }
      if (page.reserved) {
        page.pool.free.push(page.reserved.slot);
        page.reserved = undefined;
      }
    }
    this.sources.delete(record.source);
    this.cpuBytes -= record.cpuBytes;
    this.allocator.free(record.allocation);
    // Keep old snapshot objects alive for delayed feedback identity checks.
    this.routeBytes -= [...record.routes.values()].reduce(
      (bytes, route) => bytes + route.mips.length * 7 * 4,
      0
    );
    this.writeSnapshot();
    for (const page of record.pages) this.snapshot[page.id] = undefined;
  }
  private pool(format: GPUTextureFormat): Pool {
    const prior = this.pools.get(format);
    if (prior) return prior;
    const scalar = format === "bc4-r-unorm";
    const bytesPerLayer = 16 * 16 * 36 * 36 * (scalar ? 8 : 16);
    const budget = scalar
      ? this.settings.scalarBytes
      : format.endsWith("srgb")
        ? this.settings.colorBytes
        : this.settings.linearBytes;
    const layers = Math.min(
      Math.floor(budget / bytesPerLayer),
      this.graphics.device.limits.maxTextureArrayLayers
    );
    if (layers < 1) throw new RangeError("VT physical format budget cannot hold one atlas layer");
    const texture = this.graphics.device.createTexture({
      label: `VT/${format} atlas`,
      size: [VT_ATLAS_SIZE, VT_ATLAS_SIZE, layers],
      format,
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST
    });
    const capacity = layers * 256;
    const pool: Pool = {
      texture,
      view: texture.createView({ dimension: "2d-array" }),
      free: Array.from({ length: capacity }, (_, i) => capacity - i - 1),
      generations: new Uint32Array(capacity),
      owners: new Map(),
      bytes: bytesPerLayer * layers,
      pinned: 0
    };
    this.pools.set(format, pool);
    this.account(texture, pool.bytes);
    return pool;
  }
  private nextGeneration(pool: Pool, slot: number): number {
    const value = pool.generations[slot]!;
    if (value === 0xffffffff)
      throw new RangeError("VT physical generation exhausted; rebuild after epoch retirement");
    return (pool.generations[slot] = value + 1);
  }
  private staging(command: ShadeGPUCommandContext, size: number): GPUBuffer {
    if (this.stagingBytes + size > 16 * 1024 ** 2 || size > 256 * 1024) {
      throw new RangeError("VT upload staging exceeds its live/single-copy budget");
    }
    const buffer = this.graphics.device.createBuffer({
      label: "VT/transaction staging",
      size,
      usage: GPUBufferUsage.COPY_SRC,
      mappedAtCreation: true
    });
    const accounting = this.graphics.resource_accounting?.created(
      {
        kind: "buffer",
        category: "transient",
        owner: "VirtualTextureResidency/upload",
        bytes: size,
        label: buffer.label
      },
      buffer
    );
    this.stagingBytes += size;
    this.stagingPeak = Math.max(this.stagingPeak, this.stagingBytes);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      this.stagingBytes -= size;
      buffer.destroy();
      if (accounting) {
        this.graphics.resource_accounting?.destroyed(accounting);
      }
    };
    command.onAborted.addOne(release);
    command.onFinished.addOne(() => {
      void command.gpuDone.then(release, release);
    });
    return buffer;
  }
  private copyMapping(page: number, slot: number, generation: number, command: ShadeGPUCommandContext): void {
    const buffer = this.staging(command, 256);
    new Uint32Array(buffer.getMappedRange()).set([slot, generation]);
    buffer.unmap();
    command.copyBufferToTexture(
      { buffer, bytesPerRow: 256 },
      { texture: this.table, origin: [page % VT_TABLE_WIDTH, Math.floor(page / VT_TABLE_WIDTH), 0] },
      [1, 1, 1]
    );
  }
  private invalidateRange(first: number, count: number, command: ShadeGPUCommandContext): void {
    let page = first;
    const end = first + count;
    // Full rows batch up to 256KiB. Reused IDs cannot observe an old slot;
    // validity is cleared in the same ordered scene transaction as new tails.
    while (page < end) {
      const x = page % VT_TABLE_WIDTH;
      const width = Math.min(end - page, VT_TABLE_WIDTH - x);
      const rows =
        x === 0 && width === VT_TABLE_WIDTH ? Math.min(32, Math.floor((end - page) / VT_TABLE_WIDTH)) : 1;
      const pitch = Math.ceil((width * 8) / 256) * 256;
      const buffer = this.staging(command, pitch * rows);
      const words = new Uint32Array(buffer.getMappedRange());
      for (let y = 0; y < rows; y++) {
        for (let column = 0; column < width; column++) {
          words[(y * pitch) / 4 + column * 2] = VT_MISSING;
        }
      }
      buffer.unmap();
      command.copyBufferToTexture(
        { buffer, bytesPerRow: pitch, rowsPerImage: rows },
        { texture: this.table, origin: [x, Math.floor(page / VT_TABLE_WIDTH), 0] },
        [width, rows, 1]
      );
      page += width * rows;
    }
  }
  private copyTile(page: Page, slot: number, bytes: ArrayBuffer, command: ShadeGPUCommandContext): void {
    const row = 36 * (page.pool.texture.format === "bc4-r-unorm" ? 8 : 16);
    const pitch = Math.ceil(row / 256) * 256;
    if (bytes.byteLength !== row * 36) throw new RangeError("VT receipt is not one complete compressed tile");
    const buffer = this.staging(command, pitch * 36);
    const logicalBytes = bytes.byteLength;
    const copyBytes = pitch * 36;
    const target = new Uint8Array(buffer.getMappedRange());
    const source = new Uint8Array(bytes);
    for (let y = 0; y < 36; y++) target.set(source.subarray(y * row, (y + 1) * row), y * pitch);
    buffer.unmap();
    command.copyBufferToTexture(
      { buffer, bytesPerRow: pitch, rowsPerImage: 36 },
      {
        texture: page.pool.texture,
        origin: [(slot % 16) * 144, Math.floor((slot % 256) / 16) * 144, Math.floor(slot / 256)]
      },
      [144, 144, 1]
    );
    command.onFinished.addOne(() => {
      this.uploadedBytes += logicalBytes;
      this.physicalCopyBytes += copyBytes;
    });
  }
  state() {
    let pending = 0;
    for (const page of this.desired) {
      if (page.slot === VT_MISSING) {
        pending++;
      }
    }
    const feedback = this.feedback.evidence();
    return {
      frame: this.observedFrame,
      complete:
        this.observedView === this.view &&
        this.observedFrame > this.lastPublication &&
        this.observedFrame > feedback.lastGapFrame &&
        pending === 0 &&
        !this.failure &&
        feedback.overflows === feedback.recoveries,
      pending,
      limited: this.limited,
      error: this.failure,
      residencyRevision: this.residencyRevision
    };
  }
  evidence() {
    let residentBytes = 0;
    let pinnedBytes = 0;
    for (const page of this.resident) {
      const bytes = 36 * 36 * (page.pool.texture.format === "bc4-r-unorm" ? 8 : 16);
      residentBytes += bytes;
      if (page.pinned) {
        pinnedBytes += bytes;
      }
    }
    return {
      ...this.state(),
      sources: this.sources.size,
      pages: this.snapshot.filter(Boolean).length,
      resident: this.resident.size,
      pinned: [...this.resident].filter((page) => page.pinned).length,
      residentBytes,
      pinnedBytes,
      routeBytes: this.routeBytes,
      allocatedBytes:
        VT_PAGE_CAPACITY * 8 +
        [...this.pools.values()].reduce((n, p) => n + p.bytes, 0) +
        this.feedback.evidence().allocatedBytes +
        (this.queryFeedback?.evidence().allocatedBytes ?? 0),
      stagingBytes: this.stagingBytes,
      cpuMetadataAdmissionBytes: this.cpuBytes,
      stagingPeakBytes: this.stagingPeak,
      uploadBytes: this.uploadedBytes,
      physicalCopyBytes: this.physicalCopyBytes,
      evictions: this.evictions,
      reloads: this.reloads,
      rescued: this.rescued,
      demand: this.lastDemand,
      receiptBytes: this.receiptBytes,
      provider: this.sources.values().next().value?.source.preparation.evidence().tiled ?? null,
      feedback: this.feedback.evidence(),
      queryFeedback: this.queryFeedback?.evidence() ?? null
    };
  }
  private fail(error: unknown): void {
    this.failure ??= error instanceof Error ? error.message : String(error);
  }
  destroy(): void {
    if (this.stopped) return;
    this.stopped = true;
    for (const batch of this.batches) {
      batch.controller.abort();
      batch.lease?.release();
    }
    this.batches.clear();
    this.table.destroy();
    this.feedback.destroy();
    this.queryFeedback?.destroy();
    this.queryFeedbackCommand = null;
    this.queryFeedbackBuffer = null;
    this.mappingCandidate = null;
    this.primaryDemand.clear();
    this.queryDemand.clear();
    this.queryGrants.clear();
    this.lastQueryGrant.clear();
    for (const pool of this.pools.values()) pool.texture.destroy();
    for (const handle of this.accounting) {
      this.graphics.resource_accounting?.destroyed(handle);
    }
    this.accounting.length = 0;
    this.sources.clear();
    this.pools.clear();
    this.snapshot = [];
    this.admitted.clear();
    this.readyPages.clear();
    this.resident.clear();
    this.desired.clear();
    this.cpuBytes = 0;
    this.routeBytes = 0;
  }
}
