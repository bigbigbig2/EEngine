import {
  DirectionalLight,
  PointLight,
  Scene,
  ShadeDataType,
  ShadeImage,
  ShadeTexture,
  ShadeTransparencyMode,
  SpotLight,
  StandardShadeMaterial,
  buildBoxSourceGeometry,
  cookGeometryAssetPackage,
  createGeometryCookRecipe,
  load_gltf_packed,
  type BenchmarkSceneManifest,
  type GeometryAssetPackage,
  type PackedGltfSource,
  type PackedSceneSource,
  type Renderer,
  type SourceGeometry
} from "../../OEngine/src/index.ts";
import { floatToHalf } from "../../OEngine/src/loaders/float16.ts";
import { octDecode } from "../../OEngine/src/render/IblAlignment.ts";
import { GPU_INSTANCE_FLAGS } from "../../OEngine/src/gpu/GpuInstanceAbi.ts";

export type BenchmarkRuntimeProfile = "full" | "smoke";

export interface BenchmarkSceneFixture {
  scene: Scene;
  runtimeCounts: {
    instances: number;
    consumedGeometries: number;
    materials: number;
    localLights: number;
  };
  update(frameOrdinal: number): void;
}

export async function createBenchmarkSceneFixture(
  renderer: Renderer,
  manifest: BenchmarkSceneManifest,
  profile: BenchmarkRuntimeProfile
): Promise<BenchmarkSceneFixture> {
  switch (manifest.id) {
    case "A": return createA(renderer, profile);
    case "B": return createB(renderer, profile);
    case "C": return createC(renderer, profile);
  }
}

export function createFx03EnvironmentTexture(radianceScale = 1): ShadeTexture {
  if (!Number.isFinite(radianceScale) || radianceScale <= 0) {
    throw new RangeError("FX-03 environment radianceScale must be positive");
  }
  const size = 64;
  const sun = normalize3([0.35, 0.82, 0.45]);
  const halfFloatRgba = new Uint16Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const direction = octDecode([(x + 0.5) / size, (y + 0.5) / size]);
      const up = Math.max(0, direction[1] * 0.5 + 0.5);
      const sunLobe = 18 * Math.pow(Math.max(0, dot3(direction, sun)), 512);
      const horizon = Math.pow(1 - Math.abs(direction[1]), 4);
      const offset = (y * size + x) * 4;
      halfFloatRgba[offset] = floatToHalf((0.025 + 0.12 * up + 0.08 * horizon + sunLobe * 1.0) * radianceScale);
      halfFloatRgba[offset + 1] = floatToHalf((0.035 + 0.22 * up + 0.045 * horizon + sunLobe * 0.72) * radianceScale);
      halfFloatRgba[offset + 2] = floatToHalf((0.055 + 0.42 * up + 0.025 * horizon + sunLobe * 0.42) * radianceScale);
      halfFloatRgba[offset + 3] = floatToHalf(1);
    }
  }
  const image = ShadeImage.fromArrayBuffer(
    halfFloatRgba.buffer,
    4,
    ShadeDataType.Float16,
    size,
    size,
    1
  );
  image.color_space = 2;
  return ShadeTexture.from(image);
}

function dot3(a: readonly number[], b: readonly number[]): number {
  return a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
}

function normalize3(value: readonly [number, number, number]): [number, number, number] {
  const inverseLength = 1 / Math.hypot(...value);
  return [value[0] * inverseLength, value[1] * inverseLength, value[2] * inverseLength];
}

async function createA(
  renderer: Renderer,
  profile: BenchmarkRuntimeProfile
): Promise<BenchmarkSceneFixture> {
  const imported = await load_gltf_packed(
    new URL("../benchmark-assets/teapot-lod-10.glb", import.meta.url).href
  );
  const material = new StandardShadeMaterial();
  material.diffuse_color.set(0.9, 0.42, 0.08, 1);
  material.roughness_factor = 0.72;
  material.metallic_factor = 0.02;
  const gridSize = profile === "full" ? 400 : 20;
  const scene = new Scene();
  scene.lights.environment = createFx03EnvironmentTexture();
  addValidationSun(scene);
  const packed = await repeatImportedGrid(imported, [material], gridSize, 4, -1);
  await renderer.uploadPackedScene(scene, packed);
  return fixture(scene, gridSize * gridSize, packed.geometries.length, 1, 0);
}

async function createB(
  renderer: Renderer,
  profile: BenchmarkRuntimeProfile
): Promise<BenchmarkSceneFixture> {
  const imported = await loadDamagedHelmetPacked();
  const gridSize = profile === "full" ? 125 : 15;
  return createDamagedHelmetFixture(renderer, imported, gridSize, true);
}

export async function createFx03ShadingOracleFixture(renderer: Renderer): Promise<BenchmarkSceneFixture> {
  return createDamagedHelmetFixture(renderer, await loadDamagedHelmetPacked(), 1, false);
}

async function loadDamagedHelmetPacked(): Promise<PackedGltfSource> {
  const urls = {
    gltf: new URL("../benchmark-assets/damaged-helmet/DamagedHelmet.gltf", import.meta.url),
    bin: new URL("../benchmark-assets/damaged-helmet/DamagedHelmet.bin", import.meta.url),
    albedo: new URL("../benchmark-assets/damaged-helmet/Default_albedo.jpg", import.meta.url),
    ao: new URL("../benchmark-assets/damaged-helmet/Default_AO.jpg", import.meta.url),
    emissive: new URL("../benchmark-assets/damaged-helmet/Default_emissive.jpg", import.meta.url),
    metalRoughness: new URL("../benchmark-assets/damaged-helmet/Default_metalRoughness.jpg", import.meta.url),
    normal: new URL("../benchmark-assets/damaged-helmet/Default_normal.jpg", import.meta.url)
  };
  const fileEntries = await Promise.all([
    blobEntry("DamagedHelmet.bin", urls.bin),
    blobEntry("Default_albedo.jpg", urls.albedo),
    blobEntry("Default_AO.jpg", urls.ao),
    blobEntry("Default_emissive.jpg", urls.emissive),
    blobEntry("Default_metalRoughness.jpg", urls.metalRoughness),
    blobEntry("Default_normal.jpg", urls.normal)
  ]);
  const fileMap = new Map(fileEntries);
  fileMap.set(
    "Default_metalRoughness.jpg",
    await packOrmTexture(
      requiredBlob(fileMap, "Default_AO.jpg"),
      requiredBlob(fileMap, "Default_metalRoughness.jpg")
    )
  );
  const gltfResponse = await fetch(urls.gltf);
  if (!gltfResponse.ok) throw new Error(`Failed to load DamagedHelmet.gltf: ${gltfResponse.status}`);
  const gltf = await gltfResponse.json() as DamagedHelmetGltf;
  normalizeDamagedHelmetOrmContract(gltf);
  const normalizedUrl = URL.createObjectURL(new Blob(
    [JSON.stringify(gltf)],
    { type: "model/gltf+json" }
  ));
  let imported: PackedGltfSource;
  try {
    imported = await load_gltf_packed(normalizedUrl, { fileMap });
  } finally {
    URL.revokeObjectURL(normalizedUrl);
  }
  return imported;
}

async function createDamagedHelmetFixture(renderer: Renderer, imported: PackedGltfSource,
  gridSize: number, directSun: boolean): Promise<BenchmarkSceneFixture> {
  const scene = new Scene();
  scene.lights.environment = createFx03EnvironmentTexture();
  if (directSun) addValidationSun(scene);
  const packed = await repeatImportedGrid(
    imported,
    imported.materials,
    gridSize,
    4,
    -1
  );
  await renderer.uploadPackedScene(scene, packed);
  return fixture(
    scene,
    gridSize * gridSize,
    packed.geometries.length,
    packed.materials.length,
    0
  );
}

async function createC(
  renderer: Renderer,
  profile: BenchmarkRuntimeProfile
): Promise<BenchmarkSceneFixture> {
  const recipeUrl = new URL("./recipes/benchmark-c.json", import.meta.url);
  const response = await fetch(recipeUrl);
  if (!response.ok) throw new Error(`Failed to load C recipe: ${response.status}`);
  const recipe = await response.json() as BenchmarkCRecipe;
  const gridX = profile === "full" ? recipe.grid.x : 8;
  const gridZ = profile === "full" ? recipe.grid.z : 8;
  const sources = recipe.geometrySizes.map(([width, height, depth]) =>
    buildBoxSourceGeometry(width, height, depth)
  );
  const packages = await cookSources(sources);
  const materials = recipe.materials.map((entry) => {
    const material = new StandardShadeMaterial();
    material.diffuse_color.set(...entry.color);
    material.roughness_factor = entry.roughness;
    material.metallic_factor = entry.metallic;
    if (entry.alphaTested) {
      material.transparency_mode = ShadeTransparencyMode.AlphaTested;
    }
    return material;
  });
  const count = gridX * gridZ;
  const geometryIndices = new Uint32Array(count);
  const materialIndices = new Uint32Array(count);
  const currentTransforms = new Float32Array(count * 16);
  const boundsSpheres = new Float32Array(count * 4);
  const boundsMin = new Float32Array(count * 3);
  const boundsMax = new Float32Array(count * 3);
  const flags = new Uint32Array(count);
  const debugIds = new Uint32Array(count);
  const dynamicIndices: number[] = [];
  let ordinal = 0;
  for (let z = 0; z < gridZ; z++) {
    for (let x = 0; x < gridX; x++, ordinal++) {
      const geometryIndex = ordinal % sources.length;
      const materialIndex = ordinal % materials.length;
      geometryIndices[ordinal] = geometryIndex;
      materialIndices[ordinal] = materialIndex;
      setTranslationMatrix(
        currentTransforms,
        ordinal * 16,
        (x - (gridX - 1) * 0.5) * recipe.grid.spacing,
        (ordinal % 5) * 0.15,
        (z - (gridZ - 1) * 0.5) * recipe.grid.spacing
      );
      copyBounds(sources[geometryIndex]!, boundsSpheres, boundsMin, boundsMax, ordinal);
      flags[ordinal] = GPU_INSTANCE_FLAGS.CastsShadow |
        (materials[materialIndex]!.transparency_mode ===
          ShadeTransparencyMode.AlphaTested ? GPU_INSTANCE_FLAGS.AlphaTested : 0);
      debugIds[ordinal] = ordinal + 1;
      if (ordinal % recipe.dynamicTransformEvery === 0) dynamicIndices.push(ordinal);
    }
  }
  const scene = new Scene();
  scene.lights.environment = createFx03EnvironmentTexture();
  addCLights(scene, recipe);
  await renderer.uploadPackedScene(scene, {
    geometries: packages,
    materials,
    count,
    geometryIndices,
    materialIndices,
    currentTransforms,
    boundsSpheres,
    boundsMin,
    boundsMax,
    flags,
    debugIds
  });
  const patchIndices = Uint32Array.from(dynamicIndices);
  return {
    scene,
    runtimeCounts: {
      instances: count,
      consumedGeometries: packages.length,
      materials: materials.length,
      localLights: recipe.lights.point + recipe.lights.spot
    },
    update: (frameOrdinal) => {
      if (patchIndices.length === 0) return;
      const transforms = new Float32Array(patchIndices.length * 16);
      const phase = frameOrdinal / 60;
      for (let index = 0; index < patchIndices.length; index++) {
        const instanceIndex = patchIndices[index]!;
        const sourceOffset = instanceIndex * 16;
        transforms.set(
          currentTransforms.subarray(sourceOffset, sourceOffset + 16),
          index * 16
        );
        transforms[index * 16 + 13] =
          0.7 + Math.sin(phase + index * 0.37) * 0.5;
      }
      renderer.queuePackedScenePatch(scene, {
        frameId: frameOrdinal + 1,
        transforms: { indices: patchIndices, transforms }
      });
    }
  };
}

async function repeatImportedGrid(
  imported: PackedGltfSource,
  materials: readonly StandardShadeMaterial[],
  gridSize: number,
  spacing: number,
  y: number
): Promise<PackedSceneSource> {
  const packages = await cookSources(imported.geometries);
  const count = gridSize * gridSize;
  const geometryIndices = new Uint32Array(count);
  const materialIndices = new Uint32Array(count);
  const currentTransforms = new Float32Array(count * 16);
  const boundsSpheres = new Float32Array(count * 4);
  const boundsMin = new Float32Array(count * 3);
  const boundsMax = new Float32Array(count * 3);
  const flags = new Uint32Array(count);
  const debugIds = new Uint32Array(count);
  for (let index = 0; index < count; index++) {
    const importedIndex = index % imported.geometryIndices.length;
    geometryIndices[index] = imported.geometryIndices[importedIndex]!;
    materialIndices[index] = materials.length === 1
      ? 0
      : imported.materialIndices[importedIndex]!;
    const sourceTransformOffset = importedIndex * 16;
    const transformOffset = index * 16;
    currentTransforms.set(
      imported.transforms.subarray(sourceTransformOffset, sourceTransformOffset + 16),
      transformOffset
    );
    currentTransforms[transformOffset + 12] +=
      (index % gridSize - (gridSize - 1) * 0.5) * spacing;
    currentTransforms[transformOffset + 13] += y;
    currentTransforms[transformOffset + 14] +=
      (Math.floor(index / gridSize) - (gridSize - 1) * 0.5) * spacing;
    boundsSpheres.set(
      imported.boundsSpheres.subarray(importedIndex * 4, importedIndex * 4 + 4),
      index * 4
    );
    boundsMin.set(
      imported.boundsMin.subarray(importedIndex * 3, importedIndex * 3 + 3),
      index * 3
    );
    boundsMax.set(
      imported.boundsMax.subarray(importedIndex * 3, importedIndex * 3 + 3),
      index * 3
    );
    flags[index] = imported.flags[importedIndex]!;
    debugIds[index] = index + 1;
  }
  return {
    geometries: packages,
    materials,
    count,
    geometryIndices,
    materialIndices,
    currentTransforms,
    boundsSpheres,
    boundsMin,
    boundsMax,
    flags,
    debugIds
  };
}

async function cookSources(
  sources: readonly SourceGeometry[]
): Promise<readonly GeometryAssetPackage[]> {
  const recipe = createGeometryCookRecipe();
  const packages: GeometryAssetPackage[] = [];
  for (const source of sources) {
    packages.push((await cookGeometryAssetPackage(source, recipe)).asset);
  }
  return Object.freeze(packages);
}

function fixture(
  scene: Scene,
  instances: number,
  consumedGeometries: number,
  materials: number,
  localLights: number
): BenchmarkSceneFixture {
  return {
    scene,
    runtimeCounts: { instances, consumedGeometries, materials, localLights },
    update: () => {}
  };
}

function copyBounds(
  source: SourceGeometry,
  spheres: Float32Array,
  mins: Float32Array,
  maxs: Float32Array,
  instanceIndex: number
): void {
  spheres.set(source.bounds.sphere, instanceIndex * 4);
  mins.set(source.bounds.box.subarray(0, 3), instanceIndex * 3);
  maxs.set(source.bounds.box.subarray(3, 6), instanceIndex * 3);
}

function setTranslationMatrix(
  target: Float32Array,
  offset: number,
  x: number,
  y: number,
  z: number
): void {
  target[offset] = 1;
  target[offset + 5] = 1;
  target[offset + 10] = 1;
  target[offset + 12] = x;
  target[offset + 13] = y;
  target[offset + 14] = z;
  target[offset + 15] = 1;
}

function addCLights(scene: Scene, recipe: BenchmarkCRecipe): void {
  for (let index = 0; index < recipe.lights.point; index++) {
    const light = new PointLight();
    const angle = index / recipe.lights.point * Math.PI * 2;
    light.position = [Math.cos(angle) * 8, 4, Math.sin(angle) * 8];
    light.distance = 18;
    light.intensity = 22;
    light.casts_shadow = false;
    light.updateMatrices();
    scene.addChild(light);
  }
  for (let index = 0; index < recipe.lights.spot; index++) {
    const light = new SpotLight();
    light.position = [index === 0 ? -7 : 7, 9, 4];
    light.forward = [index === 0 ? 0.4 : -0.4, -1, -0.2];
    light.distance = 24;
    light.intensity = 30;
    light.casts_shadow = false;
    scene.addChild(light);
  }
  const sun = new DirectionalLight();
  sun.intensity = 3.5;
  sun.forward = [0.45, -1, -0.32];
  sun.casts_shadow = true;
  scene.addChild(sun);
}

/**
 * A/B need a readable neutral key light while R2 validates Packed material
 * reconstruction. Shadows stay disabled because the Packed CSM consumer is a
 * later gate; this light must not make G2 appear to prove that path.
 */
function addValidationSun(scene: Scene): void {
  const sun = new DirectionalLight();
  sun.intensity = 4;
  sun.forward = [0.35, -1, -0.25];
  sun.casts_shadow = false;
  scene.addChild(sun);
}

async function blobEntry(name: string, url: URL): Promise<[string, Blob]> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to load ${name}: ${response.status}`);
  return [name, await response.blob()];
}

export type ClusteredLightKind = "directional" | "point" | "spot";
export type ClusteredLightLayout = "spread" | "overlap";

export function configureClusteredLightingFixture(
  fixture: BenchmarkSceneFixture,
  count: number,
  layout: ClusteredLightLayout,
  kind: ClusteredLightKind = "point"
): void {
  const scene = fixture.scene;
  for (const child of [...scene.children]) {
    if ((child as { isLight?: boolean }).isLight === true) {
      scene.removeChild(child);
    }
  }
  const safeCount = Math.max(0, count | 0);
  for (let index = 0; index < safeCount; index++) {
    if (kind === "directional") {
      const light = new DirectionalLight();
      light.intensity = 3;
      light.forward = [0.35, -1, -0.25];
      light.casts_shadow = false;
      scene.addChild(light);
      continue;
    }
    const angle = safeCount <= 1 ? 0 : index / safeCount * Math.PI * 2;
    const ring = 4 + (index % 8) * 1.25;
    const position = layout === "overlap"
      ? [0, 4, 0] as const
      : [Math.cos(angle) * ring, 2 + (index % 5), Math.sin(angle) * ring] as const;
    if (kind === "point") {
      const light = new PointLight();
      light.position = position;
      light.distance = layout === "overlap" ? 80 : 18;
      light.radius = 0.05;
      light.intensity = 24 / Math.max(1, safeCount);
      light.casts_shadow = false;
      light.updateMatrices();
      scene.addChild(light);
    } else {
      const light = new SpotLight();
      light.position = position;
      light.forward = layout === "overlap"
        ? [0, -1, 0]
        : [-position[0], -Math.max(2, position[1]), -position[2]];
      light.distance = layout === "overlap" ? 80 : 24;
      light.angle = Math.PI / 3;
      light.penumbra = 0.25;
      light.intensity = 30 / Math.max(1, safeCount);
      light.casts_shadow = false;
      scene.addChild(light);
    }
  }
  fixture.runtimeCounts.localLights = kind === "directional" ? 0 : safeCount;
}

async function packOrmTexture(aoBlob: Blob, metallicRoughnessBlob: Blob): Promise<Blob> {
  const [ao, metallicRoughness] = await Promise.all([
    createImageBitmap(aoBlob),
    createImageBitmap(metallicRoughnessBlob)
  ]);
  try {
    if (ao.width !== metallicRoughness.width || ao.height !== metallicRoughness.height) {
      throw new Error(
        `Damaged Helmet AO/MR dimensions differ: ${ao.width}x${ao.height} vs ` +
        `${metallicRoughness.width}x${metallicRoughness.height}`
      );
    }
    const canvas = new OffscreenCanvas(ao.width, ao.height);
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (context === null) throw new Error("OffscreenCanvas 2D context is unavailable for ORM packing");
    context.drawImage(metallicRoughness, 0, 0);
    const orm = context.getImageData(0, 0, canvas.width, canvas.height);
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.drawImage(ao, 0, 0);
    const occlusion = context.getImageData(0, 0, canvas.width, canvas.height);
    for (let offset = 0; offset < orm.data.length; offset += 4) {
      orm.data[offset] = occlusion.data[offset]!;
    }
    context.putImageData(orm, 0, 0);
    return canvas.convertToBlob({ type: "image/png" });
  } finally {
    ao.close();
    metallicRoughness.close();
  }
}

function normalizeDamagedHelmetOrmContract(gltf: DamagedHelmetGltf): void {
  const material = gltf.materials?.[0];
  const metallicRoughness = material?.pbrMetallicRoughness?.metallicRoughnessTexture;
  const occlusion = material?.occlusionTexture;
  if (metallicRoughness === undefined || occlusion === undefined) {
    throw new Error("Damaged Helmet benchmark requires metallic-roughness and occlusion textures");
  }
  occlusion.index = metallicRoughness.index;
}

function requiredBlob(fileMap: ReadonlyMap<string, Blob>, name: string): Blob {
  const blob = fileMap.get(name);
  if (blob === undefined) throw new Error(`Missing benchmark asset '${name}'`);
  return blob;
}

interface BenchmarkCRecipe {
  grid: { x: number; z: number; spacing: number };
  geometrySizes: [number, number, number][];
  materials: {
    color: [number, number, number, number];
    roughness: number;
    metallic: number;
    alphaTested: boolean;
  }[];
  lights: { point: number; spot: number; directional: number };
  dynamicTransformEvery: number;
}

interface DamagedHelmetGltf {
  materials?: Array<{
    occlusionTexture?: { index: number };
    pbrMetallicRoughness?: { metallicRoughnessTexture?: { index: number } };
  }>;
}
