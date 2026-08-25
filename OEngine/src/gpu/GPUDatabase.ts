/**
 * GPU 数据库：管理分页 CPU 镜像、GPU 页表、增量上传、索引查询和异步读回。
 */

import { BitSet } from "../core/BitSet.js";
import {
  recordGpuReadback,
  submitGpuCommands,
  writeGpuBuffer
} from "./GpuQueueEvidence.js";
import { LineBuilder } from "../core/LineBuilder.js";
import { alignCeil, detectNativeEndianness } from "../core/memoryUtils.js";
import {
  ArrayType,
  CodeChunk,
  PrimitiveType,
  WebGPUType,
  WGSL_f32,
  WGSL_mat4x4f,
  WGSL_u32,
  WGSL_vec2f,
  WGSL_vec2u,
  WGSL_vec3f,
  WGSL_vec3u,
  WGSL_vec4f,
  WGSL_vec4u
} from "../core/WebGPUTypes.js";
import { StructType } from "../core/WgslStruct.js";
import { readWgslValue, writeWgslValue } from "../core/WgslBufferIO.js";
import { BinaryReader } from "../loaders/BinaryReader.js";
import type { ShadeGPUCommandContext } from "../framegraph/ShadeGPUCommandContext.js";
import type { CachedComputePipelineDescriptor } from "./GPUDescriptorCaches.js";

export const GPU_DATABASE_WORD_BYTES = WGSL_u32.size;
export const GPU_DATABASE_INVALID_PAGE = 0xffffffff;
export const GPU_DATABASE_DEFAULT_PAGE_BYTES = 131072;
export const GPU_DATABASE_DEFAULT_PAGE_LIMIT = 4096;
export const GPU_DATABASE_DEFAULT_INITIAL_BYTES = 1048576;
export const GPU_DATABASE_UPLOAD_BUFFER_LIMIT = 1048576;
export const GPU_DATABASE_UPLOAD_BATCH_BYTES = 262144;
export const GPU_DATABASE_GROW_ALIGNMENT = 65536;
export const GPU_DATABASE_UPLOAD_WORKGROUP_SIZE = 128;

function appendReadSequence(
  out: LineBuilder,
  wordOffset: number,
  database: string,
  type: WebGPUType,
  count: number
): void {
  const strideWords = type.size / GPU_DATABASE_WORD_BYTES;
  for (let i = 0; i < count; i++) {
    out.add("");
    appendReadValue(out, wordOffset + i * strideWords, database, type);
    if (i < count - 1) out.extend(", ");
  }
}

function appendReadValue(
  out: LineBuilder,
  wordOffset: number,
  database: string,
  type: WebGPUType
): void {
  if (type instanceof StructType) {
    out.extend(`${type.wgsl_ref}(`);
    out.indent();
    for (let i = 0; i < type.fields.length; i++) {
      const field = type.fields[i]!;
      out.add("");
      appendReadValue(
        out,
        wordOffset + field.offset / GPU_DATABASE_WORD_BYTES,
        database,
        field.type
      );
      if (i < type.fields.length - 1) out.extend(",");
    }
    out.dedent();
    out.add(")");
    return;
  }

  if (type instanceof ArrayType) {
    const elementType = type.type!;
    const strideWords = elementType.aligned_size / GPU_DATABASE_WORD_BYTES;
    out.extend(`${type.wgsl_ref}(`);
    out.indent();
    for (let i = 0; i < type.count; i++) {
      out.add("");
      appendReadValue(out, wordOffset + i * strideWords, database, elementType);
      if (i < type.count - 1) out.extend(",");
    }
    out.dedent();
    out.add(")");
    return;
  }

  if (!(type instanceof PrimitiveType)) {
    throw new Error(`Unsupported type ${type}`);
  }

  switch (type) {
    case WGSL_u32:
      out.extend(`u32(${database}[base_offset + ${wordOffset}])`);
      return;
    case WGSL_f32:
      out.extend(`bitcast<f32>(${database}[base_offset + ${wordOffset}])`);
      return;
    case WGSL_vec2f:
      out.extend("vec2<f32>(");
      out.indent();
      appendReadSequence(out, wordOffset, database, WGSL_f32, 2);
      out.dedent();
      out.extend(")");
      return;
    case WGSL_vec2u:
      out.extend("vec2<u32>(");
      out.indent();
      appendReadSequence(out, wordOffset, database, WGSL_u32, 2);
      out.dedent();
      out.extend(")");
      return;
    case WGSL_vec3f:
      out.extend("vec3<f32>(");
      out.indent();
      appendReadSequence(out, wordOffset, database, WGSL_f32, 3);
      out.dedent();
      out.extend(")");
      return;
    case WGSL_vec3u:
      out.extend("vec3<u32>(");
      out.indent();
      appendReadSequence(out, wordOffset, database, WGSL_u32, 3);
      out.dedent();
      out.extend(")");
      return;
    case WGSL_vec4f:
      out.extend("vec4<f32>(");
      out.indent();
      appendReadSequence(out, wordOffset, database, WGSL_f32, 4);
      out.dedent();
      out.extend(")");
      return;
    case WGSL_vec4u:
      out.extend("vec4<u32>(");
      out.indent();
      appendReadSequence(out, wordOffset, database, WGSL_u32, 4);
      out.dedent();
      out.extend(")");
      return;
    case WGSL_mat4x4f:
      out.extend("mat4x4<f32>(");
      out.indent();
      appendReadSequence(out, wordOffset, database, WGSL_vec4f, 4);
      out.dedent();
      out.extend(")");
      return;
    default:
      throw new Error(`Unsupported type ${type}`);
  }
}

function appendPrimitiveWrite(
  out: LineBuilder,
  wordOffset: number,
  database: string,
  type: WebGPUType,
  value: string
): void {
  switch (type) {
    case WGSL_u32:
      out.add(`${database}[base_offset + ${wordOffset}] = ${value};`);
      return;
    case WGSL_f32:
      out.add(`${database}[base_offset + ${wordOffset}] = bitcast<u32>(${value});`);
      return;
    case WGSL_vec2f:
      for (let i = 0; i < 2; i++) {
        appendPrimitiveWrite(out, wordOffset + i, database, WGSL_f32, `${value}[${i}]`);
      }
      return;
    case WGSL_vec3f:
      for (let i = 0; i < 3; i++) {
        appendPrimitiveWrite(out, wordOffset + i, database, WGSL_f32, `${value}[${i}]`);
      }
      return;
    case WGSL_vec4u:
      for (let i = 0; i < 4; i++) {
        appendPrimitiveWrite(out, wordOffset + i, database, WGSL_u32, `${value}[${i}]`);
      }
      return;
    case WGSL_vec4f:
      for (let i = 0; i < 4; i++) {
        appendPrimitiveWrite(out, wordOffset + i, database, WGSL_f32, `${value}[${i}]`);
      }
      return;
    case WGSL_mat4x4f:
      for (let i = 0; i < 4; i++) {
        appendPrimitiveWrite(
          out,
          wordOffset + i * 4,
          database,
          WGSL_vec4f,
          `${value}[${i}]`
        );
      }
      return;
    default:
      throw new Error(`Unsupported type ${type}`);
  }
}

function appendWriteValue(
  out: LineBuilder,
  wordOffset: number,
  database: string,
  type: WebGPUType,
  value = "value"
): void {
  if (type instanceof StructType) {
    for (const field of type.fields) {
      appendWriteValue(
        out,
        wordOffset + field.offset / GPU_DATABASE_WORD_BYTES,
        database,
        field.type,
        `${value}.${field.name}`
      );
    }
    return;
  }

  if (type instanceof ArrayType) {
    const elementType = type.type!;
    const strideWords = elementType.aligned_size / GPU_DATABASE_WORD_BYTES;
    for (let i = 0; i < type.count; i++) {
      appendWriteValue(
        out,
        wordOffset + i * strideWords,
        database,
        elementType,
        `${value}[${i}]`
      );
    }
    return;
  }

  if (!(type instanceof PrimitiveType)) {
    throw new Error(`Unsupported type ${type}`);
  }
  appendPrimitiveWrite(out, wordOffset, database, type, value);
}

export class GPUTypedTableDescriptor {
  name = "";
  index = 0;
  readonly type: WebGPUType;
  readonly page_size_bytes: number;
  readonly elements_per_page: number;
  readonly packed_element_size_bytes: number;
  readonly page_header_size_bytes: number;
  readonly page_limit: number;
  page_lookup_address = 0;

  #readChunk?: CodeChunk;
  #readWriteChunk?: CodeChunk;
  #writeChunk?: CodeChunk;
  readonly #iteratorChunks = new Map<string, CodeChunk>();

  constructor(
    type: WebGPUType,
    pageSizeBytes = 1024,
    pageLimit = GPU_DATABASE_DEFAULT_PAGE_LIMIT
  ) {
    const recordBytes = type.size;
    const rawSlots = Math.floor(pageSizeBytes / recordBytes);
    const headerBytes =
      (1 + Math.ceil(rawSlots / 32)) * GPU_DATABASE_WORD_BYTES;
    const elementsPerPage = Math.floor(
      (pageSizeBytes - headerBytes) / recordBytes
    );
    if (elementsPerPage < 1) {
      throw new Error(
        `Type '${type.tag}' (${recordBytes} bytes) is too large for page size ${pageSizeBytes} (header: ${headerBytes} bytes)`
      );
    }
    this.type = type;
    this.page_size_bytes = pageSizeBytes;
    this.elements_per_page = elementsPerPage;
    this.packed_element_size_bytes = recordBytes;
    this.page_header_size_bytes = headerBytes;
    this.page_limit = pageLimit;
  }

  get page_header_words(): number {
    return this.page_header_size_bytes / GPU_DATABASE_WORD_BYTES;
  }

  get occupancy_bitmap_words(): number {
    return this.page_header_words - 1;
  }

  get page_byte_size(): number {
    return this.page_size_bytes;
  }

  get chunk_read(): CodeChunk {
    this.#readChunk ??= this.wgsl_gen_read_code();
    return this.#readChunk;
  }

  get chunk_read_rw(): CodeChunk {
    this.#readWriteChunk ??= this.wgsl_gen_read_code(true);
    return this.#readWriteChunk;
  }

  get chunk_write(): CodeChunk {
    this.#writeChunk ??= this.wgsl_gen_write_code();
    return this.#writeChunk;
  }

  chunk_iterate(groupSize: number, readWrite = false): CodeChunk {
    const key = `${groupSize}_${readWrite ? "rw" : "r"}`;
    let chunk = this.#iteratorChunks.get(key);
    if (chunk === undefined) {
      chunk = this.wgsl_gen_iterate_code(groupSize, readWrite);
      this.#iteratorChunks.set(key, chunk);
    }
    return chunk;
  }

  get marshalling_tag(): string {
    const tag = this.type.tag.replace(/[<>]/g, "__");
    return `${tag}_${this.index}_${this.elements_per_page}`;
  }

  get marshalling_method_read(): string {
    return `database_read_${this.marshalling_tag}_element`;
  }

  get marshalling_method_read_rw(): string {
    return `database_read_rw_${this.marshalling_tag}_element`;
  }

  get marshalling_method_write(): string {
    return `database_write_${this.marshalling_tag}_element`;
  }

  marshalling_method_write_field(fieldName: string): string {
    return `database_write_${this.marshalling_tag}_element_${fieldName}`;
  }

  page_iterator_symbol_prefix(groupSize: number, readWrite = false): string {
    return `${this.marshalling_tag}_pgiter_g${groupSize}${readWrite ? "_rw" : ""}`;
  }

  wgsl_gen_read_code(readWrite = false): CodeChunk {
    const out = new LineBuilder();
    const type = this.type;
    const method = readWrite
      ? this.marshalling_method_read_rw
      : this.marshalling_method_read;
    out.add(
      `fn ${method}(database: ptr<storage, array<u32>${readWrite ? ", read_write" : ""}>, index: u32) -> ${type.wgsl_ref} {`
    );
    out.indent();
    this.appendBaseOffset(out);
    out.add("return ");
    appendReadValue(out, 0, "database", type);
    out.extend(";");
    out.dedent();
    out.add("}");
    return CodeChunk.from(
      out.build(),
      type.requires_declaration ? [type.declaration_chunk] : []
    );
  }

  wgsl_gen_write_code(): CodeChunk {
    const out = new LineBuilder();
    const type = this.type;
    out.add(
      `fn ${this.marshalling_method_write}(database: ptr<storage, array<u32>, read_write>, index: u32, value: ${type.wgsl_ref}) {`
    );
    out.indent();
    this.appendBaseOffset(out);
    appendWriteValue(out, 0, "database", type);
    out.dedent();
    out.add("}");
    return CodeChunk.from(
      out.build(),
      type.requires_declaration ? [type.declaration_chunk] : []
    );
  }

  wgsl_gen_write_field_code(fieldName: string): CodeChunk {
    if (!(this.type instanceof StructType)) {
      throw new Error(`Type '${this.type.tag}' does not contain fields`);
    }
    const field = this.type.get(fieldName);
    const fieldType = field.type;
    const out = new LineBuilder();
    const method = this.marshalling_method_write_field(fieldName);
    out.add(
      `fn ${method}(database: ptr<storage, array<u32>, read_write>, index: u32, value: ${fieldType.wgsl_ref}) {`
    );
    out.indent();
    this.appendBaseOffset(out);
    appendWriteValue(
      out,
      field.offset / GPU_DATABASE_WORD_BYTES,
      "database",
      fieldType
    );
    out.dedent();
    out.add("}");
    return CodeChunk.from(
      out.build(),
      fieldType.requires_declaration ? [fieldType.declaration_chunk] : []
    );
  }

  wgsl_gen_iterate_code(groupSize: number, readWrite = false): CodeChunk {
    const prefix = this.page_iterator_symbol_prefix(groupSize, readWrite);
    const elementsPerPage = this.elements_per_page;
    const bitmapWords = this.occupancy_bitmap_words;
    const groupsPerPage = Math.ceil(elementsPerPage / groupSize);
    const bitmapWordsPerGroup = groupSize / 32;
    const recordWords =
      this.packed_element_size_bytes / GPU_DATABASE_WORD_BYTES;
    const access = readWrite ? "read_write" : "read";
    const type = this.type;

    const declarations = CodeChunk.from(`
const ${prefix}_ELEMENTS_PER_PAGE: u32 = ${elementsPerPage}u;
const ${prefix}_GROUPS_PER_PAGE: u32 = ${groupsPerPage}u;
const ${prefix}_BITMAP_WORDS_PER_GROUP: u32 = ${bitmapWordsPerGroup}u;

var<workgroup> ${prefix}_wg_page_address: u32;
var<workgroup> ${prefix}_wg_page_index: u32;
var<workgroup> ${prefix}_wg_page_group: u32;
var<workgroup> ${prefix}_wg_occupancy_bitmap: array<u32, ${bitmapWordsPerGroup}>;
`);

    const setupBody = readWrite
      ? `
    let page_index = group_index / ${groupsPerPage}u;
    let page_group = group_index % ${groupsPerPage}u;

    if local_id == 0u {
        ${prefix}_wg_page_address = database[page_index + ${this.page_lookup_address}u];
        ${prefix}_wg_page_index = page_index;
        ${prefix}_wg_page_group = page_group;
    }

    let page_address = workgroupUniformLoad(&${prefix}_wg_page_address);
    if page_address == ~0u {
        return false;
    }

    if local_id < ${bitmapWordsPerGroup}u {
        let global_word = page_group * ${bitmapWordsPerGroup}u + local_id;
        if global_word < ${bitmapWords}u {
            ${prefix}_wg_occupancy_bitmap[local_id] = database[page_address + 1u + global_word];
        } else {
            ${prefix}_wg_occupancy_bitmap[local_id] = 0u;
        }
    }

    workgroupBarrier();
    return true;
`
      : `
    let page_index = group_index / ${groupsPerPage}u;
    let page_group = group_index % ${groupsPerPage}u;
    let page_address = database[page_index + ${this.page_lookup_address}u];

    if page_address == ~0u {
        return false;
    }

    if local_id == 0u {
        ${prefix}_wg_page_address = page_address;
        ${prefix}_wg_page_index = page_index;
        ${prefix}_wg_page_group = page_group;
    }

    if local_id < ${bitmapWordsPerGroup}u {
        let global_word = page_group * ${bitmapWordsPerGroup}u + local_id;
        if global_word < ${bitmapWords}u {
            ${prefix}_wg_occupancy_bitmap[local_id] = database[page_address + 1u + global_word];
        } else {
            ${prefix}_wg_occupancy_bitmap[local_id] = 0u;
        }
    }

    workgroupBarrier();
    return true;
`;

    const setup = CodeChunk.from(
      `
fn ${prefix}_setup(
    database: ptr<storage, array<u32>, ${access}>,
    group_index: u32,
    local_id: u32,
) -> bool {${setupBody}}
`,
      [declarations]
    );
    const slotInPage = CodeChunk.from(
      `
fn ${prefix}_slot_in_page(local_id: u32) -> u32 {
    return ${prefix}_wg_page_group * ${groupSize}u + local_id;
}
`,
      [declarations]
    );
    const isOccupied = CodeChunk.from(
      `
fn ${prefix}_is_occupied(slot_in_page: u32) -> bool {
    let group_local_slot = slot_in_page - ${prefix}_wg_page_group * ${groupSize}u;
    let bitmap_word = group_local_slot >> 5u;
    let bitmap_bit = group_local_slot & 31u;
    return (${prefix}_wg_occupancy_bitmap[bitmap_word] & (1u << bitmap_bit)) != 0u;
}
`,
      [declarations]
    );
    const slotToIndex = CodeChunk.from(
      `
fn ${prefix}_slot_to_index(slot_in_page: u32) -> u32 {
    return ${prefix}_wg_page_index * ${elementsPerPage}u + slot_in_page;
}
`,
      [declarations]
    );

    const readExpr = new LineBuilder();
    readExpr.add("");
    appendReadValue(readExpr, 0, "database", type);
    const read = CodeChunk.from(
      `
fn ${prefix}_read(
    database: ptr<storage, array<u32>, ${access}>,
    slot_in_page: u32,
) -> ${type.wgsl_ref} {
    let base_offset = ${prefix}_wg_page_address + ${this.page_header_words}u + slot_in_page * ${recordWords}u;
    return ${readExpr.build()};
}
`,
      type.requires_declaration
        ? [declarations, type.declaration_chunk]
        : [declarations]
    );

    return CodeChunk.from("", [
      declarations,
      setup,
      slotInPage,
      isOccupied,
      slotToIndex,
      read
    ]);
  }

  equals(other: GPUTypedTableDescriptor): boolean {
    return (
      this.index === other.index &&
      this.type.equals(other.type) &&
      this.elements_per_page === other.elements_per_page
    );
  }

  hash(): number {
    return this.index;
  }

  toString(): string {
    return `GPUTypedTableDescriptor{name: "${this.name}", index: ${this.index}, type: ${this.type.tag}, page_size_bytes: ${this.page_size_bytes}, elements_per_page: ${this.elements_per_page}}`;
  }

  private appendAddressLookup(out: LineBuilder): void {
    out.add(`let page_index = index / ${this.elements_per_page}u;`);
    out.add(`let page_offset = index % ${this.elements_per_page}u;`);
    out.add(`let page_lookup_index = page_index + ${this.page_lookup_address}u;`);
    out.add("let page_address = database[page_lookup_index];");
  }

  private appendBaseOffset(out: LineBuilder): void {
    this.appendAddressLookup(out);
    out.add(
      `let base_offset = page_address + ${this.page_header_words}u + page_offset * ${this.packed_element_size_bytes / GPU_DATABASE_WORD_BYTES}u;`
    );
  }
}

(GPUTypedTableDescriptor.prototype as { isGPUTypedTableDescriptor?: boolean })
  .isGPUTypedTableDescriptor = true;

export class GPUDatabaseDefinition {
  readonly descriptors: readonly GPUTypedTableDescriptor[];
  readonly page_size_bytes: number;
  private readonly descriptorByName = new Map<
    string,
    GPUTypedTableDescriptor
  >();

  constructor(
    schema: Record<string, WebGPUType>,
    pageSizeBytes = GPU_DATABASE_DEFAULT_PAGE_BYTES
  ) {
    this.page_size_bytes = pageSizeBytes;
    const descriptors: GPUTypedTableDescriptor[] = [];
    for (const name of Object.keys(schema)) {
      const descriptor = new GPUTypedTableDescriptor(
        schema[name]!,
        pageSizeBytes
      );
      descriptor.name = name;
      descriptor.index = descriptors.length;
      let lookupAddress = 0;
      for (const prior of descriptors) lookupAddress += prior.page_limit;
      descriptor.page_lookup_address = lookupAddress;
      Object.freeze(descriptor);
      descriptors.push(descriptor);
      this.descriptorByName.set(name, descriptor);
    }
    this.descriptors = Object.freeze(descriptors);
    Object.freeze(this);
  }

  static from(
    schema: Record<string, WebGPUType>,
    pageSizeBytes?: number
  ): GPUDatabaseDefinition {
    return new GPUDatabaseDefinition(schema, pageSizeBytes);
  }

  has(name: string): boolean {
    return this.descriptorByName.has(name);
  }

  get(name: string): GPUTypedTableDescriptor | undefined {
    return this.descriptorByName.get(name);
  }

  get table_count(): number {
    return this.descriptors.length;
  }
}

(GPUDatabaseDefinition.prototype as { isGPUDatabaseDefinition?: boolean })
  .isGPUDatabaseDefinition = true;

export class GPUDatabasePage {
  index = 0;
  slot_offset = -1;
  gpu_version = 0;
  cpu_version = 0;
  occupancy_count = 0;
  cpu_data_buffer?: ArrayBuffer;
  cpu_data_address = 0;

  get is_gpu_resident(): boolean {
    return this.slot_offset !== -1;
  }
}

export class FixedPageBufferPool {
  private readonly pageWords: number;
  private readonly pooled: Uint32Array[] = [];

  constructor(pageBytes: number) {
    this.pageWords = pageBytes / GPU_DATABASE_WORD_BYTES;
  }

  acquire(): Uint32Array {
    const page = this.pooled.pop();
    if (page !== undefined) {
      page.fill(0);
      return page;
    }
    return new Uint32Array(this.pageWords);
  }

  release(page: Uint32Array): void {
    this.pooled.push(page);
  }

  clear(): void {
    this.pooled.length = 0;
  }

  get pooled_count(): number {
    return this.pooled.length;
  }
}

export class FixedSlotAllocator {
  private readonly slotSizeWords: number;
  private readonly slotCountValue: number;
  private readonly freeSlots: number[];

  constructor(capacityWords: number, slotSizeWords: number) {
    this.slotSizeWords = slotSizeWords;
    this.slotCountValue = Math.floor(capacityWords / slotSizeWords);
    this.freeSlots = new Array(this.slotCountValue);
    for (let i = 0; i < this.slotCountValue; i++) {
      this.freeSlots[i] = this.slotCountValue - 1 - i;
    }
  }

  allocate(): number {
    return this.freeSlots.length === 0
      ? -1
      : this.freeSlots.pop()! * this.slotSizeWords;
  }

  free(slotOffsetWords: number): void {
    this.freeSlots.push(slotOffsetWords / this.slotSizeWords);
  }

  get free_count(): number {
    return this.freeSlots.length;
  }

  get slot_count(): number {
    return this.slotCountValue;
  }

  get slot_size(): number {
    return this.slotSizeWords;
  }
}

const tableScratchReader = new BinaryReader();
tableScratchReader.endianness = detectNativeEndianness();
const pendingReadScratch = BinaryReader.fromEndianness(
  detectNativeEndianness()
);

export class GPUTypedTable<T = unknown> {
  index = 0;
  readonly descriptor: GPUTypedTableDescriptor;
  readonly pages = new Map<number, GPUDatabasePage>();
  readonly element_upload_buffer = BinaryReader.fromEndianness(
    detectNativeEndianness()
  );
  readonly cpu_dirty_pages = new BitSet();
  readonly occupancy = new BitSet();
  readonly header_dirty_pages = new BitSet();
  page_buffer_pool?: FixedPageBufferPool;

  constructor(descriptor: GPUTypedTableDescriptor) {
    this.descriptor = descriptor;
  }

  add(value: T): number {
    const index = this.occupancy.nextClearBit(0);
    this.set(index, value);
    return index;
  }

  remove(index: number): void {
    if (!this.occupancy.get(index)) return;
    this.occupancy.set(index, false);
    const pageIndex = Math.floor(
      index / this.descriptor.elements_per_page
    );
    const page = this.pages.get(pageIndex);
    if (page === undefined) return;

    page.occupancy_count--;
    this.header_dirty_pages.set(pageIndex, true);
    if (page.cpu_data_buffer !== undefined) {
      const recordBytes = this.descriptor.packed_element_size_bytes;
      new Uint8Array(
        page.cpu_data_buffer,
        page.cpu_data_address +
          (index % this.descriptor.elements_per_page) * recordBytes,
        recordBytes
      ).fill(0);
      page.cpu_version++;
    }
    this.appendZeroUpload(index);
  }

  clear(): void {
    if (this.occupancy.cardinality() === 0) return;
    this.occupancy.reset();
    for (const [pageIndex, page] of this.pages) {
      if (page.occupancy_count !== 0) {
        page.occupancy_count = 0;
        this.header_dirty_pages.set(pageIndex, true);
      }
    }
  }

  get(index: number): T | undefined {
    const pageIndex = Math.floor(
      index / this.descriptor.elements_per_page
    );
    const page = this.pages.get(pageIndex);
    if (page === undefined) return undefined;
    if (page.cpu_data_buffer === undefined) {
      const pending = this.readPendingUpload(index);
      if (pending === undefined) {
        throw new Error(
          `Requested element ${index} is in a not CPU-resident page(${pageIndex}).`
        );
      }
      return pending;
    }
    tableScratchReader.fromArrayBuffer(page.cpu_data_buffer);
    tableScratchReader.position =
      page.cpu_data_address +
      (index % this.descriptor.elements_per_page) *
        this.descriptor.packed_element_size_bytes;
    return readWgslValue(
      tableScratchReader,
      this.descriptor.type
    ) as T;
  }

  set(index: number, value: T): void {
    const type = this.descriptor.type;
    const pageIndex = Math.floor(
      index / this.descriptor.elements_per_page
    );
    let page = this.pages.get(pageIndex);
    if (page === undefined) page = this.allocateCpuPage(pageIndex);

    const wasOccupied = this.occupancy.get(index);
    this.occupancy.set(index, true);
    if (page.cpu_data_buffer === undefined) {
      page.cpu_data_buffer = this.page_buffer_pool
        ? (this.page_buffer_pool.acquire().buffer as ArrayBuffer)
        : new ArrayBuffer(this.descriptor.page_byte_size);
    }

    const recordBytes = this.descriptor.packed_element_size_bytes;
    const cpuData = page.cpu_data_buffer;
    tableScratchReader.fromArrayBuffer(cpuData);
    tableScratchReader.position =
      page.cpu_data_address +
      (index % this.descriptor.elements_per_page) * recordBytes;
    writeWgslValue(value, tableScratchReader, type);
    page.cpu_version++;

    if (!wasOccupied) {
      page.occupancy_count++;
      this.header_dirty_pages.set(pageIndex, true);
    }

    const upload = this.element_upload_buffer;
    const uploadRecordBytes = GPU_DATABASE_WORD_BYTES + recordBytes;
    const end = upload.position;
    const searchCount = Math.min(
      256,
      Math.floor(end / uploadRecordBytes)
    );
    let existingOffset = -1;
    for (let distance = 1; distance <= searchCount; distance++) {
      const offset = end - distance * uploadRecordBytes;
      upload.position = offset;
      if (upload.readUint32() === index) {
        existingOffset = offset;
        break;
      }
    }

    if (existingOffset >= 0) {
      upload.position = existingOffset + GPU_DATABASE_WORD_BYTES;
      writeWgslValue(value, upload, type);
      upload.position = end;
    } else {
      upload.position = end;
      upload.writeUint32(index);
      writeWgslValue(value, upload, type);
      upload.position = end + uploadRecordBytes;
    }
  }

  unmap(): void {
    for (const page of this.pages.values()) {
      if (
        page.cpu_data_buffer === undefined ||
        page.cpu_version > page.gpu_version
      ) {
        continue;
      }
      page.cpu_data_buffer = undefined;
      page.cpu_data_address = 0;
    }
  }

  trim_upload_buffer(): void {
    if (this.element_upload_buffer.capacity > GPU_DATABASE_UPLOAD_BUFFER_LIMIT) {
      this.element_upload_buffer.setCapacity(
        GPU_DATABASE_UPLOAD_BUFFER_LIMIT
      );
    }
  }

  get count(): number {
    return this.occupancy.cardinality();
  }

  get dispatch_page_count(): number {
    let maxPage = -1;
    for (const pageIndex of this.pages.keys()) {
      if (pageIndex > maxPage) maxPage = pageIndex;
    }
    return maxPage + 1;
  }

  dispatch_group_count(groupSize: number): number {
    const groupsPerPage = Math.ceil(
      this.descriptor.elements_per_page / groupSize
    );
    return this.dispatch_page_count * groupsPerPage;
  }

  toString(): string {
    return this.descriptor.toString();
  }

  private appendZeroUpload(index: number): void {
    const words =
      this.descriptor.packed_element_size_bytes /
      GPU_DATABASE_WORD_BYTES;
    this.element_upload_buffer.writeUint32(index);
    for (let i = 0; i < words; i++) {
      this.element_upload_buffer.writeUint32(0);
    }
  }

  private readPendingUpload(index: number): T | undefined {
    const upload = this.element_upload_buffer;
    const end = upload.position;
    if (end <= 0) return undefined;
    const type = this.descriptor.type;
    const recordBytes = this.descriptor.packed_element_size_bytes;
    const uploadRecordBytes = recordBytes + GPU_DATABASE_WORD_BYTES;
    let result: T | undefined;
    for (let offset = 0; offset < end; offset += uploadRecordBytes) {
      upload.position = offset;
      if (upload.readUint32() !== index) continue;
      pendingReadScratch.ensureCapacity(recordBytes);
      const dst = new Uint8Array(pendingReadScratch.data, 0, recordBytes);
      const src = new Uint8Array(
        upload.data,
        offset + GPU_DATABASE_WORD_BYTES,
        recordBytes
      );
      dst.set(src);
      pendingReadScratch.position = 0;
      result = readWgslValue(pendingReadScratch, type) as T;
      break;
    }
    upload.position = end;
    return result;
  }

  private allocateCpuPage(pageIndex: number): GPUDatabasePage {
    if (this.pages.has(pageIndex)) {
      throw new Error("page already allocated");
    }
    const page = new GPUDatabasePage();
    page.index = pageIndex;
    page.cpu_data_buffer = this.page_buffer_pool
      ? (this.page_buffer_pool.acquire().buffer as ArrayBuffer)
      : new ArrayBuffer(this.descriptor.page_byte_size);
    this.pages.set(pageIndex, page);
    this.cpu_dirty_pages.set(pageIndex, true);
    return page;
  }
}

const GPU_DATABASE_UPLOAD_SETTINGS_TYPE = StructType.from({
  count: WGSL_u32,
  record_size: WGSL_u32,
  elements_per_page: WGSL_u32,
  page_lookup_address: WGSL_u32,
  page_header_words: WGSL_u32,
  page_limit: WGSL_u32
}).pack();

const GPU_DATABASE_UPLOAD_WGSL = `struct Struct_66{
    count : u32,
    record_size : u32,
    elements_per_page : u32,
    page_lookup_address : u32,
    page_header_words : u32,
    page_limit : u32,
}
@group(0) @binding(0) var<storage, read> shift : array< u32 >;
@group(0) @binding(1) var<storage, read_write> database : array< u32 >;
@group(0) @binding(2) var<uniform> settings : Struct_66;

@compute @workgroup_size(128)
fn main(@builtin(global_invocation_id) traced_harmonics : vec3<u32>){
    let shader_sdf_distance_sqr = traced_harmonics.x;
${"    "}
    if(shader_sdf_distance_sqr >= settings.count){
        return;
    }
${"    "}
    let optimized_move_x = shader_sdf_distance_sqr * ( settings.record_size + 1 );
    let j = shift[optimized_move_x];
${"    "}
    let cursor = j / settings.elements_per_page;
    let t3 = j % settings.elements_per_page;
${"    "}
    if(cursor >= settings.page_limit){

        return;
    }

    let gi_radiance = cursor + settings.page_lookup_address;
    let needs_destructor_signature = database[gi_radiance];


    if(needs_destructor_signature == 0xFFFFFFFFu){
        return;
    }

    let raw_destructor_signature = needs_destructor_signature + settings.page_header_words + t3 * settings.record_size;
${"    "}

    for(var seed_budget_ms = 0u; seed_budget_ms < settings.record_size; seed_budget_ms++){
        database[raw_destructor_signature + seed_budget_ms] = shift[optimized_move_x + seed_budget_ms + 1u];
    }
${"    "}
}
` + "        ";

export type GPUDatabaseOptions = {
  definition: GPUDatabaseDefinition;
  device: GPUDevice;
  initial_data_size_bytes?: number;
};

const GPU_DATABASE_UPLOAD_GROUP: GPUBindGroupLayoutDescriptor = {
  label: "",
  entries: [
    {
      binding: 0,
      visibility: GPUShaderStage.COMPUTE,
      buffer: { type: "read-only-storage" }
    },
    {
      binding: 1,
      visibility: GPUShaderStage.COMPUTE,
      buffer: { type: "storage" }
    },
    {
      binding: 2,
      visibility: GPUShaderStage.COMPUTE,
      buffer: { type: "uniform" }
    }
  ]
};

const GPU_DATABASE_UPLOAD_PIPELINE: CachedComputePipelineDescriptor = {
  label: "",
  layout: { label: "", bindGroupLayouts: [GPU_DATABASE_UPLOAD_GROUP] },
  compute: {
    module: { label: "", code: GPU_DATABASE_UPLOAD_WGSL },
    entryPoint: "main"
  }
};

export class GPUDatabase {
  readonly definition: GPUDatabaseDefinition;
  readonly tables: GPUTypedTable[];
  buffer: GPUBuffer;

  private device: GPUDevice;
  private readonly pageBufferPool: FixedPageBufferPool;
  private pageLookup: Uint32Array;
  private dirtyLookupStart = Number.POSITIVE_INFINITY;
  private dirtyLookupEnd = -1;
  private dataStartOffsetWords: number;
  private slotAllocator: FixedSlotAllocator;

  constructor({
    definition,
    device,
    initial_data_size_bytes = GPU_DATABASE_DEFAULT_INITIAL_BYTES
  }: GPUDatabaseOptions) {
    this.definition = definition;
    this.device = device;
    this.pageBufferPool = new FixedPageBufferPool(
      definition.page_size_bytes
    );
    this.tables = new Array(definition.descriptors.length);
    for (let i = 0; i < definition.descriptors.length; i++) {
      const table = new GPUTypedTable(definition.descriptors[i]!);
      table.index = i;
      table.page_buffer_pool = this.pageBufferPool;
      this.tables[i] = table;
    }

    let lookupWords = 0;
    for (const descriptor of definition.descriptors) {
      lookupWords += descriptor.page_limit;
    }
    this.pageLookup = new Uint32Array(lookupWords);
    this.pageLookup.fill(GPU_DATABASE_INVALID_PAGE);
    this.dirtyLookupStart = 0;
    this.dirtyLookupEnd = this.pageLookup.length - 1;

    const lookupBytes = this.pageLookup.byteLength;
    const dataStartBytes = alignCeil(
      lookupBytes,
      GPU_DATABASE_WORD_BYTES
    );
    this.dataStartOffsetWords =
      dataStartBytes / GPU_DATABASE_WORD_BYTES;
    const bufferBytes = Math.max(
      initial_data_size_bytes,
      lookupBytes
    );
    const dataCapacityWords = Math.floor(
      (bufferBytes - dataStartBytes) / GPU_DATABASE_WORD_BYTES
    );
    this.slotAllocator = new FixedSlotAllocator(
      dataCapacityWords,
      this.pageSlotWords
    );
    this.buffer = device.createBuffer({
      size: bufferBytes,
      usage:
        GPUBufferUsage.STORAGE |
        GPUBufferUsage.COPY_SRC |
        GPUBufferUsage.COPY_DST,
      mappedAtCreation: false
    });
  }

  get(name: string): GPUTypedTable | undefined {
    const descriptor = this.definition.get(name);
    return descriptor === undefined
      ? undefined
      : this.tables[descriptor.index];
  }

  get data_start_offset(): number {
    return this.dataStartOffsetWords;
  }

  get page_size_bytes(): number {
    return this.definition.page_size_bytes;
  }

  get gpu_memory_usage(): number {
    return this.buffer.size;
  }

  update(command: ShadeGPUCommandContext): void {
    for (const table of this.tables) {
      const dirtyPages = table.cpu_dirty_pages;
      for (
        let pageIndex = dirtyPages.nextSetBit(0);
        pageIndex !== -1;
        pageIndex = dirtyPages.nextSetBit(pageIndex + 1)
      ) {
        const page = table.pages.get(pageIndex)!;
        if (!page.is_gpu_resident) {
          this.allocateGpuPage(table, page.index);
        }
      }
      dirtyPages.reset();
      this.releaseEmptyPages(table);
    }

    this.uploadDirtyLookup();

    for (const table of this.tables) {
      this.encodeElementUploads(command, table);
    }
    for (const table of this.tables) {
      this.uploadDirtyHeaders(table);
    }
    for (const table of this.tables) {
      for (const page of table.pages.values()) {
        page.gpu_version = page.cpu_version;
      }
    }
  }

  async debug_table_read_all<T = unknown>(name: string): Promise<T[]> {
    const table = this.get(name) as GPUTypedTable<T> | undefined;
    if (table === undefined) {
      throw new Error(`Table '${name}' does not exist`);
    }
    const bytes = await this.readBufferRange(0, this.buffer.size);
    const words = new Uint32Array(bytes);
    const byteView = new Uint8Array(bytes);
    const descriptor = table.descriptor;
    const recordBytes = descriptor.packed_element_size_bytes;
    const recordWords = recordBytes / GPU_DATABASE_WORD_BYTES;
    const elementBuffer = new ArrayBuffer(recordBytes);
    const elementBytes = new Uint8Array(elementBuffer);
    const reader = BinaryReader.fromArrayBuffer(elementBuffer);
    reader.endianness = detectNativeEndianness();
    const result: T[] = [];

    for (let pageIndex = 0; pageIndex < descriptor.page_limit; pageIndex++) {
      const pageAddress =
        words[descriptor.page_lookup_address + pageIndex]!;
      if (pageAddress === GPU_DATABASE_INVALID_PAGE) continue;
      if (words[pageAddress] === 0) continue;
      const elementStart = pageAddress + descriptor.page_header_words;
      for (
        let bitmapWord = 0;
        bitmapWord < descriptor.occupancy_bitmap_words;
        bitmapWord++
      ) {
        const occupancy = words[pageAddress + 1 + bitmapWord]!;
        if (occupancy === 0) continue;
        for (let bit = 0; bit < 32; bit++) {
          if ((occupancy & (1 << bit)) === 0) continue;
          const slot = (bitmapWord << 5) + bit;
          const index =
            pageIndex * descriptor.elements_per_page + slot;
          const byteOffset =
            (elementStart + slot * recordWords) *
            GPU_DATABASE_WORD_BYTES;
          elementBytes.set(
            byteView.subarray(byteOffset, byteOffset + recordBytes)
          );
          reader.position = 0;
          result[index] = readWgslValue(
            reader,
            descriptor.type
          ) as T;
        }
      }
    }
    return result;
  }

  async debug_table_read_element<T = unknown>(
    name: string,
    index: number
  ): Promise<T | undefined> {
    const table = this.get(name) as GPUTypedTable<T> | undefined;
    if (table === undefined) {
      throw new Error(`Table '${name}' does not exist`);
    }
    const descriptor = table.descriptor;
    const pageIndex = Math.floor(index / descriptor.elements_per_page);
    const page = table.pages.get(pageIndex);
    if (page === undefined || !page.is_gpu_resident) return undefined;
    const byteOffset =
      (page.slot_offset +
        this.dataStartOffsetWords +
        descriptor.page_header_words +
        (index % descriptor.elements_per_page) *
          (descriptor.packed_element_size_bytes /
            GPU_DATABASE_WORD_BYTES)) *
      GPU_DATABASE_WORD_BYTES;
    const bytes = await this.readBufferRange(
      byteOffset,
      descriptor.packed_element_size_bytes
    );
    const reader = BinaryReader.fromArrayBuffer(bytes);
    reader.endianness = detectNativeEndianness();
    return readWgslValue(reader, descriptor.type) as T;
  }

  destroy(): void {
    this.buffer.destroy();
    this.pageBufferPool.clear();
    this.device = null as unknown as GPUDevice;
  }

  private get pageSlotWords(): number {
    return (
      alignCeil(
        this.definition.page_size_bytes,
        GPU_DATABASE_WORD_BYTES
      ) / GPU_DATABASE_WORD_BYTES
    );
  }

  private grow(newByteSize: number): void {
    const device = this.device;
    if (newByteSize > device.limits.maxStorageBufferBindingSize) {
      throw new Error(
        `Cannot grow database to ${newByteSize} bytes, max allowed is ${device.limits.maxStorageBufferBindingSize}`
      );
    }

    const lookupBytes = this.pageLookup.byteLength;
    const dataStartWords = this.dataStartOffsetWords;
    const dataCapacityWords = Math.floor(
      (newByteSize -
        dataStartWords * GPU_DATABASE_WORD_BYTES) /
        GPU_DATABASE_WORD_BYTES
    );
    const pageWords = this.pageSlotWords;
    const pageBytes = pageWords * GPU_DATABASE_WORD_BYTES;
    const nextAllocator = new FixedSlotAllocator(
      dataCapacityWords,
      pageWords
    );
    const previous = this.buffer;
    const next = device.createBuffer({
      size: newByteSize,
      usage: previous.usage,
      mappedAtCreation: false
    });
    const copies: Array<[number, number]> = [];

    for (const table of this.tables) {
      const lookupBase = table.descriptor.page_lookup_address;
      for (const [pageIndex, page] of table.pages) {
        if (!page.is_gpu_resident) continue;
        const sourceByteOffset =
          (page.slot_offset + dataStartWords) *
          GPU_DATABASE_WORD_BYTES;
        const nextSlot = nextAllocator.allocate();
        if (nextSlot < 0) {
          throw new Error("Grown database cannot fit resident pages");
        }
        const destinationByteOffset =
          (nextSlot + dataStartWords) *
          GPU_DATABASE_WORD_BYTES;
        copies.push([sourceByteOffset, destinationByteOffset]);
        page.slot_offset = nextSlot;
        const lookupIndex = lookupBase + pageIndex;
        this.pageLookup[lookupIndex] =
          nextSlot + dataStartWords;
        this.markLookupDirty(lookupIndex);
      }
    }

    const encoder = device.createCommandEncoder({ label: "" });
    encoder.copyBufferToBuffer(
      previous,
      0,
      next,
      0,
      lookupBytes
    );
    for (const [source, destination] of copies) {
      encoder.copyBufferToBuffer(
        previous,
        source,
        next,
        destination,
        pageBytes
      );
    }
    submitGpuCommands(device, "GPUDatabase/grow", [encoder.finish()]);
    previous.destroy();
    this.buffer = next;
    this.slotAllocator = nextAllocator;
  }

  private growByFactor(): void {
    const current = this.buffer.size;
    const limit = this.device.limits.maxStorageBufferBindingSize;
    if (current === limit) {
      throw new Error(
        `Cannot grow database, already at max allowed capacity ${limit}`
      );
    }
    const next = Math.min(
      alignCeil(1.2 * current, GPU_DATABASE_GROW_ALIGNMENT),
      limit
    );
    this.grow(next);
  }

  private allocateGpuPage(
    table: GPUTypedTable,
    pageIndex: number
  ): GPUDatabasePage {
    const descriptor = table.descriptor;
    if (pageIndex >= descriptor.page_limit) {
      throw new Error(
        `Page index ${pageIndex} is out of bounds (page_limit: ${descriptor.page_limit})`
      );
    }
    let slot = this.slotAllocator.allocate();
    while (slot === -1) {
      this.growByFactor();
      slot = this.slotAllocator.allocate();
    }

    let page = table.pages.get(pageIndex);
    if (page === undefined) {
      page = new GPUDatabasePage();
      page.index = pageIndex;
      table.pages.set(pageIndex, page);
    }
    page.slot_offset = slot;
    const lookupIndex =
      descriptor.page_lookup_address + pageIndex;
    this.pageLookup[lookupIndex] =
      slot + this.dataStartOffsetWords;
    this.markLookupDirty(lookupIndex);
    return page;
  }

  private releaseEmptyPages(table: GPUTypedTable): void {
    for (const [pageIndex, page] of table.pages) {
      if (page.occupancy_count > 0 || !page.is_gpu_resident) continue;
      this.slotAllocator.free(page.slot_offset);
      page.slot_offset = -1;
      const lookupIndex =
        table.descriptor.page_lookup_address + pageIndex;
      this.pageLookup[lookupIndex] = GPU_DATABASE_INVALID_PAGE;
      this.markLookupDirty(lookupIndex);
      if (page.cpu_data_buffer !== undefined) {
        this.pageBufferPool.release(
          new Uint32Array(page.cpu_data_buffer)
        );
        page.cpu_data_buffer = undefined;
        page.cpu_data_address = 0;
      }
      table.pages.delete(pageIndex);
    }
  }

  private markLookupDirty(index: number): void {
    this.dirtyLookupStart = Math.min(
      this.dirtyLookupStart,
      index
    );
    this.dirtyLookupEnd = Math.max(this.dirtyLookupEnd, index);
  }

  private uploadDirtyLookup(): void {
    if (this.dirtyLookupStart > this.dirtyLookupEnd) return;
    const startBytes =
      this.dirtyLookupStart * Uint32Array.BYTES_PER_ELEMENT;
    const endBytes =
      (this.dirtyLookupEnd + 1) *
      Uint32Array.BYTES_PER_ELEMENT;
    writeGpuBuffer(
      this.device.queue,
      "GPUDatabase/page-lookup",
      this.buffer,
      startBytes,
      this.pageLookup.buffer,
      startBytes,
      endBytes - startBytes
    );
    this.dirtyLookupStart = Number.POSITIVE_INFINITY;
    this.dirtyLookupEnd = -1;
  }

  private encodeElementUploads(
    command: ShadeGPUCommandContext,
    table: GPUTypedTable
  ): void {
    const upload = table.element_upload_buffer;
    const uploadBytes = upload.position;
    if (uploadBytes === 0) return;

    const descriptor = table.descriptor;
    const uploadRecordBytes =
      descriptor.packed_element_size_bytes +
      GPU_DATABASE_WORD_BYTES;
    const recordCount = uploadBytes / uploadRecordBytes;
    const recordsPerBatch = Math.max(
      1,
      Math.floor(
        GPU_DATABASE_UPLOAD_BATCH_BYTES / uploadRecordBytes
      )
    );
    let recordOffset = 0;
    while (recordOffset < recordCount) {
      const batchCount = Math.min(
        recordsPerBatch,
        recordCount - recordOffset
      );
      const sourceByteOffset = recordOffset * uploadRecordBytes;
      const batchBytes = batchCount * uploadRecordBytes;
      const settingsBuffer = command.allocateTransientValueBuffer(
        GPU_DATABASE_UPLOAD_SETTINGS_TYPE,
        {
          count: batchCount,
          record_size:
            descriptor.packed_element_size_bytes /
            GPU_DATABASE_WORD_BYTES,
          elements_per_page: descriptor.elements_per_page,
          page_lookup_address: descriptor.page_lookup_address,
          page_header_words: descriptor.page_header_words,
          page_limit: descriptor.page_limit
        }
      );
      const uploadBuffer = command.allocateTransientBufferAndLoad(
        upload.data,
        GPUBufferUsage.STORAGE,
        sourceByteOffset,
        batchBytes
      );

      const pass = command.constructComputePass({
        pipeline: GPU_DATABASE_UPLOAD_PIPELINE,
        bindings: [[
          { buffer: uploadBuffer },
          { buffer: this.buffer },
          { buffer: settingsBuffer }
        ]]
      });
      pass.dispatchWorkgroups(
        Math.ceil(
          batchCount / GPU_DATABASE_UPLOAD_WORKGROUP_SIZE
        )
      );
      pass.end();
      recordOffset += batchCount;
    }

    upload.position = 0;
    table.trim_upload_buffer();
  }

  private uploadDirtyHeaders(table: GPUTypedTable): void {
    const dirty = table.header_dirty_pages;
    if (dirty.size() === 0) return;
    const descriptor = table.descriptor;
    const elementsPerPage = descriptor.elements_per_page;
    const headerWords = descriptor.page_header_words;
    const bitmapWords = headerWords - 1;
    const header = new Uint32Array(headerWords);

    for (
      let pageIndex = dirty.nextSetBit(0);
      pageIndex !== -1;
      pageIndex = dirty.nextSetBit(pageIndex + 1)
    ) {
      const page = table.pages.get(pageIndex);
      if (page === undefined || !page.is_gpu_resident) continue;
      header[0] = page.occupancy_count;
      for (let i = 1; i <= bitmapWords; i++) header[i] = 0;
      const firstIndex = pageIndex * elementsPerPage;
      const endIndex = firstIndex + elementsPerPage;
      for (
        let index = table.occupancy.nextSetBit(firstIndex);
        index !== -1 && index < endIndex;
        index = table.occupancy.nextSetBit(index + 1)
      ) {
        const slot = index - firstIndex;
        header[1 + (slot >> 5)]! |= 1 << (slot & 31);
      }
      writeGpuBuffer(
        this.device.queue,
        "GPUDatabase/page-header",
        this.buffer,
        (page.slot_offset + this.dataStartOffsetWords) *
          GPU_DATABASE_WORD_BYTES,
        header.buffer,
        0,
        descriptor.page_header_size_bytes
      );
    }
    dirty.reset();
  }

  private async readBufferRange(
    byteOffset: number,
    byteLength: number
  ): Promise<ArrayBuffer> {
    const size = alignCeil(
      byteLength,
      GPU_DATABASE_WORD_BYTES
    );
    const readback = this.device.createBuffer({
      size,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
    });
    const encoder = this.device.createCommandEncoder({ label: "" });
    encoder.copyBufferToBuffer(
      this.buffer,
      byteOffset,
      readback,
      0,
      size
    );
    recordGpuReadback(this.device, "GPUDatabase/read", size);
    submitGpuCommands(this.device, "GPUDatabase/read", [encoder.finish()]);
    await readback.mapAsync(GPUMapMode.READ);
    const result = readback
      .getMappedRange(0, byteLength)
      .slice(0);
    readback.unmap();
    readback.destroy();
    return result;
  }
}
