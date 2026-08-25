/**
 * @module reconstructed/src/gpu/GPUSceneContext
 * @evidence isGPUSceneContext → aL; pretty L35849–36018; [S]
 * @status migrated (aL owner/update/build ordering aligned through B12)
 * @module-dissection artifacts/slices/REBOOT-R4-gpuscene/
 *
 * GPU Scene：`_g/cg/dg` → paged `oI` → 独立 Dd `GPUSceneContext/database-build`。
 * G6-17：materials.metadata_table 使用 lm.pack() 80B ABI，仍为 dense lifecycle。
 * `qz/Nz -> nE -> yh -> Ch/qf` shadow/cluster direct-light consumer 已接；
 * B3 已闭合 source/clone geometry index → BLAS address 与当前 ray-query consumer；
 * 其余渲染域继续按后续批次收口。
 */

import type { Scene } from "../scene/Scene.js";
import type { Mesh } from "../scene/Mesh.js";
import type { Node3D } from "../scene/Node3D.js";
import { ShadeGPUCommandContext } from "../framegraph/ShadeGPUCommandContext.js";
import {
  SceneDatabase,
  type TransformTableRow,
  type GpuBufferSlice,
} from "./SceneDatabase.js";
import { MeshletGpuTable } from "./MeshletGpuTable.js";
import { GPULightCollection } from "./LightDatabase.js";
import { GPUAnimationManager } from "./AnimationDatabase.js";
import { TopLevelAccelerationStructure } from "./TopLevelAccelerationStructure.js";
import { GPUSkinningManager } from "./GPUSkinningManager.js";
import { GPULightProbeVolume } from "./GPULightProbeVolume.js";
import { Brick4LightMap } from "./Brick4LightMap.js";
import { GPUVolumetrics } from "./GPUVolumetrics.js";
import type { GPUMaterialRegistry } from "./GPUMaterialContext.js";
import type { GraphicsContext } from "./GraphicsContext.js";
import type { SceneChangeSnapshot } from "../scene/SceneChangeSet.js";
import { applySceneTransformChanges } from "./GPUSceneChangeSynchronizer.js";

export interface GPUSceneContextMembers {
  geometries: MeshletGpuTable;
  materials: GPUMaterialRegistry;
  volumetric_light_map: Brick4LightMap;
  volumetrics: GPUVolumetrics;
  scene: Scene;
  lights: GPULightCollection;
  light_probe_volume: GPULightProbeVolume;
  tlas: TopLevelAccelerationStructure;
  scene_database: SceneDatabase;
  scene_database_buffer: GPUBuffer | null;
  animation_manager: GPUAnimationManager;
  skinning: GPUSkinningManager;
  id_mapping: Map<number, number>;
}

/**
 * @evidence pretty aL labels L35996 / L36001
 */
export const GPU_SCENE_COMMAND_LABELS = {
  databaseBuild: "GPUSceneContext/database-build",
  animationFlush: "GPUSceneContext/animation-flush",
} as const;

let nextGpuSceneId = 1;

export class GPUSceneContext implements GPUSceneContextMembers {
  readonly isGPUSceneContext = true;
  readonly id: number;
  readonly scene: Scene;
  /** CPU node id → transforms 行 */
  readonly id_mapping = new Map<number, number>();
  readonly scene_database: SceneDatabase;
  /** G5-1: 全局 meshlet headers/data + per-mesh meshlets_address */
  readonly meshlets: MeshletGpuTable;

  get material_metadata() {
    return this.materials.metadata_table;
  }

  /** @evidence iL.#it: both owners are injected from GraphicsContext. */
  readonly geometries: MeshletGpuTable;
  readonly materials: GPUMaterialRegistry;
  readonly volumetric_light_map: Brick4LightMap;
  readonly volumetrics: GPUVolumetrics;
  readonly lights: GPULightCollection;
  readonly light_probe_volume: GPULightProbeVolume;
  readonly tlas: TopLevelAccelerationStructure;
  readonly animation_manager: GPUAnimationManager;
  private _skinning: GPUSkinningManager | null = null;

  private device: GPUDevice;
  private readonly graphics: GraphicsContext;
  /** 当前 GPU Scene 已消费到的 Scene Change Set revision。 */
  private _lastSceneChangeRevision = -1;
  /** @evidence #fo dirty */
  private _dirty = true;
  private readonly _globalTmp = new Float32Array(16);
  private readonly _prevGlobalTmp = new Float32Array(16);
  private readonly _trScratch: TransformTableRow = {
    local_translation: new Float32Array(3),
    local_rotation: new Float32Array(4),
    local_scale: new Float32Array(3),
    global: this._globalTmp,
    prev_global: this._prevGlobalTmp,
    parent: 0,
  };

  /** CPU mesh id → mesh 表行（调试 / Vis；对等 #do 意图） */
  readonly meshRowByCpuId = new Map<number, number>();

  constructor(
    graphics: GraphicsContext,
    scene: Scene,
    sharedGeometries: MeshletGpuTable,
    sharedMaterials: GPUMaterialRegistry
  ) {
    const device = graphics.device;
    if (device === null) {
      throw new Error("GPUSceneContext: GraphicsContext has no device");
    }
    this.id = nextGpuSceneId++;
    this.device = device;
    this.graphics = graphics;
    this.scene = scene;
    this.meshlets = sharedGeometries;
    this.geometries = this.meshlets;
    this.materials = sharedMaterials;
    this.tlas = new TopLevelAccelerationStructure(device);
    this.scene_database = new SceneDatabase(graphics);
    this.lights = new GPULightCollection(graphics, scene.lights);
    this.light_probe_volume = new GPULightProbeVolume(
      graphics,
      scene.light_probe_volume,
    );
    this.volumetric_light_map = new Brick4LightMap(device);
    this.volumetrics = new GPUVolumetrics(device, scene.volumetrics);
    this.animation_manager = new GPUAnimationManager(
      graphics,
      `GPUSceneContext[${this.id}]/Animation`,
      this,
    );
  }

  /**
   * Original `aL.skinning` is lazy: constructing a GPU scene does not create
   * the `rL` owner or any skinning GPU state. `build()` obtains it when the
   * geometry table is actually resolved, and later consumers share that owner.
   *
   * @evidence `aL.skinning` L35905-L35915; `rL` constructor L35584-L35586.
   */
  get skinning(): GPUSkinningManager {
    if (this._skinning === null) {
      this._skinning = new GPUSkinningManager({
        device: this.device,
        geometries: this.meshlets,
        animation_manager: this.animation_manager,
        scene_context: this,
      });
    }
    return this._skinning;
  }

  get scene_database_buffer(): GPUBuffer | null {
    return this.scene_database.buffer;
  }

  /** @evidence aL.gpu_memory_usage L35917-L35924. */
  get gpu_memory_usage(): number {
    return (
      this.scene_database.gpu_memory_usage +
      this.lights.gpu_memory_usage +
      this.light_probe_volume.gpu_memory_usage +
      this.volumetric_light_map.gpu_memory_usage
    );
  }

  /**
   * @deprecated G0-2 起与 scene_database_buffer 同缓冲；请用 transformSlice
   */
  get transform_buffer(): GPUBuffer | null {
    return this.scene_database.transformBuffer;
  }

  get meshSlice(): GpuBufferSlice | null {
    return this.scene_database.meshSlice;
  }

  get transformSlice(): GpuBufferSlice | null {
    return this.scene_database.transformSlice;
  }

  get mesh_count(): number {
    return this.scene_database.meshCount;
  }

  get transform_count(): number {
    return this.scene_database.transformCount;
  }

  /**
   * build 顺序对齐 pretty aL L35931–35998（子集）。
   * 上传：独立 Dd label `GPUSceneContext/database-build`。
   * @evidence excerpts/02-al-build.md L124–128
   */
  build(): void {
    const instances = this.scene.instances.instances;
    const n = instances.length;

    // 1) All scenes share the Graphics-owned fz registry. A scene rebuild may
    // obtain its materials, but must never clear another scene's records.
    // @evidence aL.build L35935 materials.obtain; fz.obtain → metadata_table.set
    for (let i = 0; i < n; i++) {
      const mat = instances[i]!.material;
      if (!mat) continue;
      this.materials.obtain(mat);
    }

    // 2) Original resolves all shared zP geometry/clone indices before TLAS
    // and table rebuild, then reads the same stable index again for mesh rows.
    const skinning = this.skinning;
    for (let i = 0; i < n; i++) {
      skinning.obtain_geometry_index(instances[i]!);
    }

    // 3) fT TLAS：CPU dynamic BVH，叶 user_data = Scene mesh row。
    this.scene.updateMatrices();
    this.tlas.clear();
    for (let i = 0; i < n; i++) {
      this.tlas.instance_add(i, instances[i]!);
    }

    // 4–5) #do exact-size owner, then clear only per-scene tables/state.
    this.scene_database.resizeReverseMapping(n);
    this.scene_database.clear();
    this.id_mapping.clear();
    this.meshRowByCpuId.clear();

    // 6–10) transforms：根 → mesh 节点 → 非 mesh 节点；补 parent
    const deferredParents: Node3D[] = [];

    const addNode = (node: Node3D): number => {
      let parentRow = 0;
      if (node.parent) {
        const mapped = this.id_mapping.get(node.parent.id);
        if (mapped === undefined) {
          deferredParents.push(node);
          parentRow = 0;
        } else {
          parentRow = mapped;
        }
      }
      const row = this.packNodeRow(node, parentRow);
      const id = this.scene_database.addTransform(row);
      this.id_mapping.set(node.id, id);
      return id;
    };

    // 根 scene 也是 Node3D 子树根
    addNode(this.scene);

    for (let i = 0; i < n; i++) {
      addNode(instances[i]!);
    }

    for (const node of this.scene.instances.nodes) {
      if ((node as Mesh).isMesh || this.id_mapping.has(node.id)) continue;
      addNode(node);
    }

    // 补 parent（父后到）
    for (const node of deferredParents) {
      const selfRow = this.id_mapping.get(node.id);
      if (selfRow === undefined) continue;
      const parentRow = node.parent
        ? (this.id_mapping.get(node.parent.id) ?? 0)
        : 0;
      this.scene_database.setTransform(
        selfRow,
        this.packNodeRow(node, parentRow),
      );
    }

    // 11) mesh 表 + #do
    for (let i = 0; i < n; i++) {
      const mesh = instances[i]!;
      const nodeRow = this.id_mapping.get(mesh.id) ?? 0;
      const geometry = this.obtainGeometryIndex(mesh);
      const material = mesh.material?.id ?? 0;
      const row = this.scene_database.addMesh(
        {
          geometry,
          material,
          node: nodeRow,
          bounding_box: mesh.bounding_box,
          bounding_sphere: mesh.bounding_sphere,
        },
        mesh.id,
        mesh.version,
      );
      this.meshRowByCpuId.set(mesh.id, row);
    }

    // 12) GPU 上传 — 独立 Dd（对齐 aL；oI compute 仍 gap，自建 writeBuffer）
    this.uploadDatabaseBuild();

    this._lastSceneChangeRevision = this.scene.change_revision;
    this._dirty = false;
  }

  /**
   * @evidence pretty aL.update L35999 — 子系统 stub；version → build
   * 参数：可选 main Dd（当前未用于上传；animation-flush 仍 gap）。
   */
  update(graphics: GraphicsContext = this.graphics): void {
    const changes = this.scene.changesSince(this._lastSceneChangeRevision);
    this.light_probe_volume.update();
    this.lights.update(
      changes.fullResyncRequired || changes.changedLights.length > 0
    );
    this.volumetrics.update(graphics, 0);
    const animationCommand = ShadeGPUCommandContext.create(
      this.graphics,
      GPU_SCENE_COMMAND_LABELS.animationFlush,
    );
    this.animation_manager.update(animationCommand);
    animationCommand.finish();

    if (
      this._dirty ||
      changes.fullResyncRequired ||
      changes.instanceStructureChanged
    ) {
      this.build();
    } else if (
      changes.transformedNodes.length > 0 ||
      changes.changedMeshBounds.length > 0
    ) {
      this.applyTransformChanges(changes);
    }
    this._lastSceneChangeRevision = changes.revision;
    this.tlas.update();
  }

  /**
   * @evidence pretty aL.tick L36007 — main Dd + dt；G0 animation 空
   */
  tick(_cmd: ShadeGPUCommandContext | null, _dt: number): void {
    if (_cmd !== null) this.animation_manager.tick(_cmd, _dt);
  }

  markDirty(): void {
    this._dirty = true;
  }

  destroy(): void {
    this.scene_database.destroy();
    this.lights.destroy();
    this.animation_manager.destroy();
    this._skinning?.destroy();
    this._skinning = null;
    this.tlas.destroy();
    this.light_probe_volume.destroy();
    this.volumetric_light_map.destroy();
    this.id_mapping.clear();
    this.meshRowByCpuId.clear();
  }

  /**
   * @evidence L35996–35997：Dd.create → geometries.update → scene_database.update → finish
   */
  private uploadDatabaseBuild(): void {
    const label = GPU_SCENE_COMMAND_LABELS.databaseBuild;
    const cmd = ShadeGPUCommandContext.create(
      this.graphics,
      label,
    );
    // Original submits only shared geometry updates followed by the per-scene
    // paged database. Draw-list and global material owners update elsewhere.
    this.meshlets.update(cmd, `GPUSceneContext[${this.id}]`);
    this.scene_database.update(cmd);
    cmd.finish();
  }

  /**
   * geometry 索引：有 skinning 池则走 clone/original pool；否则走 Jg 去重表。
   * @evidence skinning.obtain_geometry_index
   */
  private obtainGeometryIndex(mesh: Mesh): number {
    return this.skinning.obtain_geometry_index(mesh) >>> 0;
  }

  private applyTransformChanges(changes: SceneChangeSnapshot): void {
    const result = applySceneTransformChanges(changes, {
      transformRowFor: (node) => this.id_mapping.get(node.id),
      meshRowFor: (mesh) => this.meshRowByCpuId.get(mesh.id),
      hasMeshRow: (row) => this.scene_database.readMeshRow(row) !== null,
      writeTransform: (row, node, parentRow, previousGlobal) => {
        this.scene_database.setTransform(
          row,
          this.packNodeRow(node, parentRow, previousGlobal)
        );
      },
      writeMeshBounds: (row, mesh) => {
        const current = this.scene_database.readMeshRow(row);
        if (current === null) return;
        this.scene_database.setMesh(
          row,
          {
            geometry: current.geometry,
            material: current.material,
            node: current.node,
            bounding_box: mesh.bounding_box,
            bounding_sphere: mesh.bounding_sphere
          },
          mesh.id,
          mesh.version
        );
      },
      updateTlas: (row, mesh) => this.tlas.instance_update(row, mesh),
      flush: () => {
        const command = ShadeGPUCommandContext.create(
          this.graphics,
          "GPUSceneContext/database-incremental-update"
        );
        this.scene_database.update(command);
        command.finish();
      }
    });

    if (result.requiresFullRebuild) {
      this.build();
    }
  }

  private packNodeRow(
    node: Node3D,
    parentRow: number,
    previousGlobal: ArrayLike<number> = node.transform_global.matrix
  ): TransformTableRow {
    const local = node.transform_local;
    const global = node.transform_global.matrix;
    const lt = this._trScratch.local_translation as Float32Array;
    const lr = this._trScratch.local_rotation as Float32Array;
    const ls = this._trScratch.local_scale as Float32Array;
    lt[0] = local.position.x;
    lt[1] = local.position.y;
    lt[2] = local.position.z;
    lr[0] = local.rotation.x;
    lr[1] = local.rotation.y;
    lr[2] = local.rotation.z;
    lr[3] = local.rotation.w;
    ls[0] = local.scale.x;
    ls[1] = local.scale.y;
    ls[2] = local.scale.z;
    this._globalTmp.set(global);
    this._prevGlobalTmp.set(previousGlobal);
    return {
      local_translation: lt,
      local_rotation: lr,
      local_scale: ls,
      global: this._globalTmp,
      prev_global: this._prevGlobalTmp,
      parent: parentRow,
    };
  }

  private findNodeById(id: number): Node3D | null {
    if (this.scene.id === id) return this.scene;
    for (const m of this.scene.instances.instances) {
      if (m.id === id) return m;
    }
    let found: Node3D | null = null;
    this.scene.traverse((n) => {
      if (n.id === id) found = n;
    });
    return found;
  }
}
