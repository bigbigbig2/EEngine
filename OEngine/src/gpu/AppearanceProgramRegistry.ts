/** Explicit compute resource profile; no implicit/auto pipeline layouts. */
export interface AppearanceProgramDescriptor {
  readonly source: string;
  readonly entryPoint: string;
  readonly workgroupSize: number;
  readonly groups: readonly (readonly GPUBindGroupLayoutEntry[])[];
}

export interface AppearanceProgramLease {
  readonly key: string;
  readonly ready: Promise<
    Readonly<{
      pipeline: GPUComputePipeline;
      layouts: readonly GPUBindGroupLayout[];
    }>
  >;
  /** Releases publication ownership, including during compilation. Idempotent. */
  release(): void;
}

export interface AppearanceProgramBudget {
  readonly maxPrograms: number;
  readonly maxConcurrentCompiles: number;
  readonly maxSourceBytes: number;
}

interface Entry {
  readonly key: string;
  readonly descriptor: AppearanceProgramDescriptor;
  readonly ready: AppearanceProgramLease["ready"];
  readonly resolve: (value: Awaited<AppearanceProgramLease["ready"]>) => void;
  readonly reject: (reason: unknown) => void;
  refs: number;
  age: number;
  state: "queued" | "compiling" | "ready" | "failed";
}

/**
 * GPU program lifecycle glue. Bounded topology/resource families shared across
 * material instances. Admission happens during publication, never during draw.
 * No encoder, submit, readback, or material-instance numeric values in the key.
 */
export class AppearanceProgramRegistry {
  private readonly entries = new Map<string, Entry>();
  private readonly queue: Entry[] = [];
  private readonly stopListeners = new Set<(reason: Error) => void>();
  private readonly fieldPublications = new Map<string, number>();
  private readonly publicationObjects = new WeakMap<object, number>();
  private nextPublicationObject = 1;
  private compiling = 0;
  private age = 0;
  private failure: Error | null = null;
  private readonly budget: AppearanceProgramBudget;

  constructor(
    private readonly device: GPUDevice,
    budget: AppearanceProgramBudget = {
      maxPrograms: 128,
      maxConcurrentCompiles: 4,
      maxSourceBytes: 512 * 1024,
    },
  ) {
    for (const [name, value] of Object.entries(budget)) {
      if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`Invalid Appearance ${name}`);
    }
    if (budget.maxConcurrentCompiles > budget.maxPrograms) {
      throw new RangeError("Appearance compile concurrency exceeds program capacity");
    }
    this.budget = Object.freeze({ ...budget });
    void device.lost.then(
      (info) => this.stop(new Error(`Appearance GPUDevice lost: ${info.reason}: ${info.message}`)),
      (cause) => this.stop(new Error("Appearance GPUDevice loss promise failed", { cause })),
    );
  }

  /** Publication-time exact interning, not a hash. IDs retain a complete
   * immutable field DAG/data witness across unrelated publication replacement.
   * Mutable values keep their GPU field version and material scope separately. */
  internFieldPublication(witness: string): number {
    const existing = this.fieldPublications.get(witness);
    if (existing !== undefined) {
      return existing;
    }
    if (this.fieldPublications.size >= 262144) {
      throw new RangeError("Appearance field publication identity budget exhausted");
    }
    const identity = this.fieldPublications.size + 1;
    this.fieldPublications.set(witness, identity);
    return identity;
  }

  publicationObjectIdentity(value: object): number {
    const existing = this.publicationObjects.get(value);
    if (existing !== undefined) {
      return existing;
    }
    if (this.nextPublicationObject >= 0xfffffffe) {
      throw new RangeError("Appearance source identity exhausted");
    }
    const identity = this.nextPublicationObject++;
    this.publicationObjects.set(value, identity);
    return identity;
  }

  acquire(descriptor: AppearanceProgramDescriptor): AppearanceProgramLease {
    if (this.failure !== null) throw this.failure;
    const snapshot = snapshotDescriptor(descriptor);
    validateProfile(this.device.limits, snapshot, this.budget.maxSourceBytes);
    const key = JSON.stringify(snapshot);
    let entry = this.entries.get(key);
    if (entry === undefined) {
      this.reserve();
      let resolve!: Entry["resolve"], reject!: Entry["reject"];
      const ready = new Promise<Awaited<AppearanceProgramLease["ready"]>>((yes, no) => {
        resolve = yes;
        reject = no;
      });
      // Releasing/aborting a publication before await must not create an unhandled rejection.
      void ready.catch(() => undefined);
      entry = {
        key,
        descriptor: snapshot,
        ready,
        resolve,
        reject,
        refs: 0,
        age: ++this.age,
        state: "queued",
      };
      this.entries.set(key, entry);
      this.queue.push(entry);
    }
    const owned = entry;
    owned.refs++;
    owned.age = ++this.age;
    let released = false;
    this.pump();
    return Object.freeze({
      key,
      ready: owned.ready,
      release: (): void => {
        if (released) return;
        released = true;
        owned.refs--;
        owned.age = ++this.age;
        if (owned.refs === 0 && owned.state === "queued") {
          const index = this.queue.indexOf(owned);
          if (index >= 0) this.queue.splice(index, 1);
          this.entries.delete(key);
          owned.state = "failed";
          owned.reject(new Error("Appearance publication cancelled before compilation"));
        } else if (owned.refs === 0 && owned.state === "failed") this.entries.delete(key);
      },
    });
  }

  /** Negotiate a complete resource profile before any publication resources are created. */
  preflight(descriptor: AppearanceProgramDescriptor): void {
    if (this.failure !== null) throw this.failure;
    validateProfile(this.device.limits, descriptor, this.budget.maxSourceBytes);
  }

  evidence(): Readonly<{
    programs: number;
    referenced: number;
    queued: number;
    compiling: number;
    stopped: boolean;
  }> {
    return Object.freeze({
      programs: this.entries.size,
      referenced: [...this.entries.values()].filter((entry) => entry.refs > 0).length,
      queued: this.queue.length,
      compiling: this.compiling,
      stopped: this.failure !== null,
    });
  }

  destroy(): void {
    this.stop(new Error("AppearanceProgramRegistry destroyed"));
  }

  /** Resident publications unregister on retirement; no per-scene device.lost closures. */
  onStopped(callback: (reason: Error) => void): () => void {
    if (this.failure !== null) callback(this.failure);
    else this.stopListeners.add(callback);
    return () => {
      this.stopListeners.delete(callback);
    };
  }

  private reserve(): void {
    if (this.entries.size < this.budget.maxPrograms) return;
    let victim: Entry | undefined;
    for (const entry of this.entries.values()) {
      if (
        entry.refs === 0 &&
        (entry.state === "ready" || entry.state === "failed") &&
        (victim === undefined || entry.age < victim.age)
      )
        victim = entry;
    }
    if (victim === undefined)
      throw new RangeError("Appearance program family capacity exhausted before publication");
    this.entries.delete(victim.key);
  }

  private pump(): void {
    while (
      this.failure === null &&
      this.compiling < this.budget.maxConcurrentCompiles &&
      this.queue.length > 0
    ) {
      const entry = this.queue.shift()!;
      entry.state = "compiling";
      this.compiling++;
      void this.compile(entry)
        .then(
          (value) => {
            if (this.failure !== null) return;
            entry.state = "ready";
            entry.resolve(value);
          },
          (error) => {
            entry.state = "failed";
            entry.reject(error);
            if (entry.refs === 0) this.entries.delete(entry.key);
          },
        )
        .finally(() => {
          this.compiling--;
          this.pump();
        });
    }
  }

  private async compile(entry: Entry): Promise<Awaited<AppearanceProgramLease["ready"]>> {
    // Pop synchronously before awaiting: concurrent compiles must not nest a
    // device-global error-scope stack across asynchronous boundaries.
    this.device.pushErrorScope("validation");
    let module: GPUShaderModule, layouts: GPUBindGroupLayout[], pipelineLayout: GPUPipelineLayout;
    let creationError: Promise<GPUError | null>;
    try {
      module = this.device.createShaderModule({ label: "Appearance/program", code: entry.descriptor.source });
      layouts = entry.descriptor.groups.map((entries) => this.device.createBindGroupLayout({ entries }));
      pipelineLayout = this.device.createPipelineLayout({ bindGroupLayouts: layouts });
    } finally {
      creationError = this.device.popErrorScope();
    }
    const [scope, info] = await Promise.all([creationError, module.getCompilationInfo()]);
    if (scope !== null) throw new Error(`Appearance resource/module validation: ${scope.message}`);
    const errors = info.messages.filter((message) => message.type === "error");
    if (errors.length > 0)
      throw new Error(
        errors
          .map((message) => `Appearance WGSL ${message.lineNum}:${message.linePos}: ${message.message}`)
          .join("\n"),
      );
    if (this.failure !== null) throw this.failure;
    const pipeline = await this.device.createComputePipelineAsync({
      label: "Appearance/program",
      layout: pipelineLayout,
      compute: { module, entryPoint: entry.descriptor.entryPoint },
    });
    if (this.failure !== null) throw this.failure;
    return Object.freeze({ pipeline, layouts: Object.freeze(layouts) });
  }

  private stop(reason: Error): void {
    if (this.failure !== null) return;
    this.failure = reason;
    for (const entry of this.entries.values()) if (entry.state !== "ready") entry.reject(reason);
    this.queue.length = 0;
    this.entries.clear();
    for (const callback of this.stopListeners) callback(reason);
    this.stopListeners.clear();
  }
}

function snapshotDescriptor(value: AppearanceProgramDescriptor): AppearanceProgramDescriptor {
  const groups = value.groups.map((group) =>
    Object.freeze(
      [...group]
        .sort((a, b) => a.binding - b.binding)
        .map((entry) =>
          Object.freeze({
            binding: entry.binding,
            visibility: entry.visibility,
            ...(entry.buffer === undefined ? {} : { buffer: Object.freeze({ ...entry.buffer }) }),
            ...(entry.sampler === undefined ? {} : { sampler: Object.freeze({ ...entry.sampler }) }),
            ...(entry.texture === undefined ? {} : { texture: Object.freeze({ ...entry.texture }) }),
            ...(entry.storageTexture === undefined
              ? {}
              : { storageTexture: Object.freeze({ ...entry.storageTexture }) }),
          }),
        ),
    ),
  );
  return Object.freeze({
    source: value.source,
    entryPoint: value.entryPoint,
    workgroupSize: value.workgroupSize,
    groups: Object.freeze(groups),
  });
}

function validateProfile(
  limits: GPUSupportedLimits,
  value: AppearanceProgramDescriptor,
  maxSourceBytes: number,
): void {
  if (new TextEncoder().encode(value.source).byteLength > maxSourceBytes)
    throw new RangeError("Appearance WGSL source budget exceeded");
  if (
    value.entryPoint.length === 0 ||
    !Number.isSafeInteger(value.workgroupSize) ||
    value.workgroupSize < 1 ||
    value.workgroupSize > limits.maxComputeWorkgroupSizeX ||
    value.workgroupSize > limits.maxComputeInvocationsPerWorkgroup
  ) {
    throw new RangeError("Appearance workgroup/entry point exceeds negotiated profile");
  }
  if (value.groups.length > limits.maxBindGroups)
    throw new RangeError("Appearance bind group limit exceeded");
  let storage = 0,
    uniform = 0,
    textures = 0,
    samplers = 0,
    storageTextures = 0;
  for (const group of value.groups) {
    if (group.length > limits.maxBindingsPerBindGroup)
      throw new RangeError("Appearance group binding capacity exceeded");
    const seen = new Set<number>();
    for (const entry of group) {
      if (
        !Number.isInteger(entry.binding) ||
        entry.binding < 0 ||
        entry.binding >= limits.maxBindingsPerBindGroup ||
        seen.has(entry.binding) ||
        entry.visibility !== GPUShaderStage.COMPUTE
      )
        throw new RangeError("Invalid Appearance compute binding");
      seen.add(entry.binding);
      if (
        [entry.buffer, entry.sampler, entry.texture, entry.storageTexture].filter((x) => x !== undefined)
          .length !== 1
      ) {
        throw new TypeError("Appearance binding requires one explicit resource kind");
      }
      if (entry.buffer !== undefined) {
        if (entry.buffer.hasDynamicOffset)
          throw new TypeError("Appearance profile uses task offsets, not dynamic bindings");
        const isUniform = entry.buffer.type === "uniform" || entry.buffer.type === undefined;
        if (isUniform) uniform++;
        else storage++;
        const maximum = Math.min(
          Number(limits.maxBufferSize),
          Number(isUniform ? limits.maxUniformBufferBindingSize : limits.maxStorageBufferBindingSize),
        );
        const minimum = entry.buffer.minBindingSize ?? 0;
        if (!Number.isSafeInteger(minimum) || minimum < 0 || minimum > maximum)
          throw new RangeError("Appearance binding byte limit exceeded");
      } else if (entry.texture !== undefined) textures++;
      else if (entry.sampler !== undefined) samplers++;
      else storageTextures++;
    }
  }
  for (const [used, maximum, name] of [
    [storage, limits.maxStorageBuffersPerShaderStage, "storage buffers"],
    [uniform, limits.maxUniformBuffersPerShaderStage, "uniform buffers"],
    [textures, limits.maxSampledTexturesPerShaderStage, "textures"],
    [samplers, limits.maxSamplersPerShaderStage, "samplers"],
    [storageTextures, limits.maxStorageTexturesPerShaderStage, "storage textures"],
  ] as const) {
    if (used > maximum)
      throw new RangeError(`Appearance ${name} exceed negotiated device limit (${used}/${maximum})`);
  }
}
