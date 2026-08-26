import {
  BoxGeometry,
  DirectionalLight,
  Mesh,
  PointLight,
  Scene,
  ShadeDataType,
  ShadeImage,
  ShadeTexture,
  ShadeTransparencyMode,
  SpotLight,
  StandardShadeMaterial,
  load_gltf,
  type BenchmarkSceneManifest
} from "../../OEngine/src/index.ts";

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
  manifest: BenchmarkSceneManifest,
  profile: BenchmarkRuntimeProfile
): Promise<BenchmarkSceneFixture> {
  switch (manifest.id) {
    case "A": return createA(profile);
    case "B": return createB(profile);
    case "C": return createC(profile);
  }
}

function createEnvironmentTexture(): ShadeTexture {
  const halfFloatRgba = new Uint16Array([0x2a66, 0x2e66, 0x3266, 0x3c00]);
  const image = ShadeImage.fromArrayBuffer(
    halfFloatRgba.buffer,
    4,
    ShadeDataType.Float16,
    1,
    1,
    1
  );
  image.color_space = 2;
  return ShadeTexture.from(image);
}

async function createA(profile: BenchmarkRuntimeProfile): Promise<BenchmarkSceneFixture> {
  const source = await firstMesh(
    new URL("../benchmark-assets/teapot-lod-10.glb", import.meta.url).href
  );
  const material = new StandardShadeMaterial();
  material.diffuse_color.set(0.9, 0.42, 0.08, 1);
  material.roughness_factor = 0.72;
  material.metallic_factor = 0.02;
  const gridSize = profile === "full" ? 400 : 20;
  const gridOrigin = profile === "full" ? 200 : gridSize * 0.5;
  const scene = new Scene();
  scene.lights.environment = createEnvironmentTexture();
  for (let z = 0; z < gridSize; z++) {
    for (let x = 0; x < gridSize; x++) {
      const mesh = Mesh.from(source.geometry, material);
      mesh.position = [(x - gridOrigin) * 4, -1, (z - gridOrigin) * 4];
      mesh.updateMatrices();
      scene.addChild(mesh);
    }
  }
  return {
    scene,
    runtimeCounts: {
      instances: gridSize * gridSize,
      consumedGeometries: 1,
      materials: 1,
      localLights: 0
    },
    update: () => {}
  };
}

async function createB(profile: BenchmarkRuntimeProfile): Promise<BenchmarkSceneFixture> {
  const urls = {
    gltf: new URL("../../three.js/examples/models/gltf/DamagedHelmet/glTF/DamagedHelmet.gltf", import.meta.url),
    bin: new URL("../../three.js/examples/models/gltf/DamagedHelmet/glTF/DamagedHelmet.bin", import.meta.url),
    albedo: new URL("../../three.js/examples/models/gltf/DamagedHelmet/glTF/Default_albedo.jpg", import.meta.url),
    ao: new URL("../../three.js/examples/models/gltf/DamagedHelmet/glTF/Default_AO.jpg", import.meta.url),
    emissive: new URL("../../three.js/examples/models/gltf/DamagedHelmet/glTF/Default_emissive.jpg", import.meta.url),
    metalRoughness: new URL("../../three.js/examples/models/gltf/DamagedHelmet/glTF/Default_metalRoughness.jpg", import.meta.url),
    normal: new URL("../../three.js/examples/models/gltf/DamagedHelmet/glTF/Default_normal.jpg", import.meta.url)
  };
  const fileEntries = await Promise.all([
    blobEntry("DamagedHelmet.bin", urls.bin),
    blobEntry("Default_albedo.jpg", urls.albedo),
    blobEntry("Default_AO.jpg", urls.ao),
    blobEntry("Default_emissive.jpg", urls.emissive),
    blobEntry("Default_metalRoughness.jpg", urls.metalRoughness),
    blobEntry("Default_normal.jpg", urls.normal)
  ]);
  const bundle = await load_gltf(urls.gltf.href, { fileMap: new Map(fileEntries) });
  const source = findFirstMesh(bundle.scenes);
  const gridSize = profile === "full" ? 125 : 15;
  const scene = new Scene();
  scene.lights.environment = createEnvironmentTexture();
  for (let z = 0; z < gridSize; z++) {
    for (let x = 0; x < gridSize; x++) {
      // Preserve the authored z-up → engine transform carried by the glTF node.
      const mesh = source.clone();
      mesh.position = [(x - (gridSize - 1) * 0.5) * 4, -1, (z - (gridSize - 1) * 0.5) * 4];
      mesh.updateMatrices();
      scene.addChild(mesh);
    }
  }
  return {
    scene,
    runtimeCounts: {
      instances: gridSize * gridSize,
      consumedGeometries: 1,
      materials: 1,
      localLights: 0
    },
    update: () => {}
  };
}

async function createC(profile: BenchmarkRuntimeProfile): Promise<BenchmarkSceneFixture> {
  const recipeUrl = new URL("./recipes/benchmark-c.json", import.meta.url);
  const response = await fetch(recipeUrl);
  if (!response.ok) throw new Error(`Failed to load C recipe: ${response.status}`);
  const recipe = await response.json() as BenchmarkCRecipe;
  const gridX = profile === "full" ? recipe.grid.x : 8;
  const gridZ = profile === "full" ? recipe.grid.z : 8;
  const geometries = recipe.geometrySizes.map(
    ([width, height, depth]) => new BoxGeometry(width, height, depth)
  );
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
  const scene = new Scene();
  scene.lights.environment = createEnvironmentTexture();
  const dynamicMeshes: Mesh[] = [];
  let ordinal = 0;
  for (let z = 0; z < gridZ; z++) {
    for (let x = 0; x < gridX; x++) {
      const mesh = Mesh.from(
        geometries[ordinal % geometries.length]!,
        materials[ordinal % materials.length]!
      );
      mesh.position = [
        (x - (gridX - 1) * 0.5) * recipe.grid.spacing,
        (ordinal % 5) * 0.15,
        (z - (gridZ - 1) * 0.5) * recipe.grid.spacing
      ];
      mesh.updateMatrices();
      scene.addChild(mesh);
      if (ordinal % recipe.dynamicTransformEvery === 0) dynamicMeshes.push(mesh);
      ordinal++;
    }
  }
  addCLights(scene, recipe);
  return {
    scene,
    runtimeCounts: {
      instances: gridX * gridZ,
      consumedGeometries: geometries.length,
      materials: materials.length,
      localLights: recipe.lights.point + recipe.lights.spot
    },
    update: (frameOrdinal) => {
      const phase = frameOrdinal / 60;
      dynamicMeshes.forEach((mesh, index) => {
        mesh.position.y = 0.7 + Math.sin(phase + index * 0.37) * 0.5;
        mesh.updateMatrices();
      });
    }
  };
}

function addCLights(scene: Scene, recipe: BenchmarkCRecipe): void {
  for (let index = 0; index < recipe.lights.point; index++) {
    const light = new PointLight();
    const angle = index / recipe.lights.point * Math.PI * 2;
    light.position = [Math.cos(angle) * 8, 4, Math.sin(angle) * 8];
    light.distance = 18;
    light.intensity = 22;
    light.casts_shadow = index === 0;
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

async function firstMesh(url: string): Promise<Mesh> {
  const bundle = await load_gltf(url);
  return findFirstMesh(bundle.scenes);
}

function findFirstMesh(roots: readonly { traverse(callback: (node: unknown) => void): void }[]): Mesh {
  let found: Mesh | null = null;
  for (const root of roots) {
    root.traverse((node) => {
      if (found === null && (node as { isMesh?: boolean }).isMesh === true) {
        found = node as Mesh;
      }
    });
  }
  if (found === null) throw new Error("Benchmark asset did not contain a Mesh");
  return found;
}

async function blobEntry(name: string, url: URL): Promise<[string, Blob]> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to load ${name}: ${response.status}`);
  return [name, await response.blob()];
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
