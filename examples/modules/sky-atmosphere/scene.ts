import {
  BoxGeometry,
  Mesh,
  Scene,
  StandardShadeMaterial
} from "../../../OEngine/src/index.ts";
import { Attribute } from "../../../OEngine/src/geometry/Attribute.ts";
import { MeshletGeometryBase } from "../../../OEngine/src/geometry/BoxGeometry.ts";
import { Geometry } from "../../../OEngine/src/geometry/Geometry.ts";
import { MeshletAttrName } from "../../../OEngine/src/geometry/meshletPackedAttrs.ts";
import { niFromGeometry } from "../../../OEngine/src/geometry/niMeshlets.ts";

const GROUND_HALF_EXTENT = 15_000;
const SCENE_SCALE = 1.6;
const SUN_IRRADIANCE = [1.25, 1.48, 1.7] as const;

export type LightingDiagnostic =
  | "all"
  | "background-only"
  | "diffuse-only"
  | "specular-only"
  | "direct-only"
  | "aerial-only";

export interface SkySceneSettings {
  sunAzimuth: number;
  sunElevation: number;
  sunScale: number;
  skyScale: number;
  aerial: boolean;
  lightingView: LightingDiagnostic;
}

export const SKY_SCENE_DEFAULTS: Readonly<SkySceneSettings> = Object.freeze({
  sunAzimuth: 125,
  sunElevation: 42,
  sunScale: 1.6,
  skyScale: 1.8,
  aerial: true,
  lightingView: "all"
});

function srgbToLinear(value: number): number {
  const normalized = value / 255;
  return normalized <= 0.04045
    ? normalized / 12.92
    : ((normalized + 0.055) / 1.055) ** 2.4;
}

function material(name: string, hex: number, roughness: number, metallic = 0): StandardShadeMaterial {
  const value = new StandardShadeMaterial();
  value.name = name;
  value.diffuse_color.set(
    srgbToLinear((hex >>> 16) & 0xff),
    srgbToLinear((hex >>> 8) & 0xff),
    srgbToLinear(hex & 0xff),
    1
  );
  value.roughness_factor = roughness;
  value.metallic_factor = metallic;
  return value;
}

function createGroundGeometry(): MeshletGeometryBase {
  const geometry = new Geometry();
  geometry.name = "Mesa Commons ground";
  geometry.index = Attribute.from(new Uint32Array([0, 2, 1, 0, 3, 2]), 1, "index");
  geometry.addAttribute(
    Attribute.from(
      new Float32Array([
        -GROUND_HALF_EXTENT, 0, -GROUND_HALF_EXTENT,
        GROUND_HALF_EXTENT, 0, -GROUND_HALF_EXTENT,
        GROUND_HALF_EXTENT, 0, GROUND_HALF_EXTENT,
        -GROUND_HALF_EXTENT, 0, GROUND_HALF_EXTENT
      ]),
      3,
      MeshletAttrName.Position
    )
  );
  geometry.addAttribute(
    Attribute.from(new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]), 3, MeshletAttrName.Normal)
  );
  geometry.addAttribute(
    Attribute.from(new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), 2, MeshletAttrName.Uv0)
  );
  return niFromGeometry(geometry, new MeshletGeometryBase());
}

function createLowPolySphere(radius: number, rings = 20, segments = 32): MeshletGeometryBase {
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];

  for (let ring = 0; ring <= rings; ring++) {
    const phi = (ring / rings) * Math.PI;
    const sinPhi = Math.sin(phi);
    const cosPhi = Math.cos(phi);
    for (let segment = 0; segment <= segments; segment++) {
      const theta = (segment / segments) * Math.PI * 2;
      const normal = [sinPhi * Math.cos(theta), cosPhi, sinPhi * Math.sin(theta)];
      positions.push(normal[0]! * radius, normal[1]! * radius, normal[2]! * radius);
      normals.push(normal[0]!, normal[1]!, normal[2]!);
      uvs.push(segment / segments, ring / rings);
    }
  }

  for (let ring = 0; ring < rings; ring++) {
    for (let segment = 0; segment < segments; segment++) {
      const first = ring * (segments + 1) + segment;
      const second = first + segments + 1;
      if (ring > 0) indices.push(first, first + 1, second);
      if (ring < rings - 1) indices.push(first + 1, second + 1, second);
    }
  }

  const geometry = new Geometry();
  geometry.name = "Low-poly sun stone";
  geometry.index = Attribute.from(new Uint32Array(indices), 1, "index");
  geometry.addAttribute(Attribute.from(new Float32Array(positions), 3, MeshletAttrName.Position));
  geometry.addAttribute(Attribute.from(new Float32Array(normals), 3, MeshletAttrName.Normal));
  geometry.addAttribute(Attribute.from(new Float32Array(uvs), 2, MeshletAttrName.Uv0));
  return niFromGeometry(geometry, new MeshletGeometryBase());
}

function applyEnvironment(scene: Scene, settings: SkySceneSettings): void {
  const elevation = (settings.sunElevation * Math.PI) / 180;
  const azimuth = (settings.sunAzimuth * Math.PI) / 180;
  scene.physical_environment.setSun(
    [
      Math.sin(azimuth) * Math.cos(elevation),
      Math.sin(elevation),
      Math.cos(azimuth) * Math.cos(elevation)
    ],
    [
      SUN_IRRADIANCE[0] * settings.sunScale,
      SUN_IRRADIANCE[1] * settings.sunScale,
      SUN_IRRADIANCE[2] * settings.sunScale
    ]
  );
  scene.physical_environment.setSkyLuminanceScale(settings.skyScale);
  scene.physical_environment.setLightingDiagnostic(settings.lightingView, settings.aerial);
}

export function createSkyScene() {
  const scene = new Scene();
  const groundMaterial = material("Warm gray aggregate ground", 0xa69d8e, 0.94);
  const platformMaterial = material("Weathered concrete", 0x78838d, 0.76);
  const basaltMaterial = material("Deep basalt", 0x354252, 0.84);
  const ceramicMaterial = material("Muted coral marker", 0xb85f52, 0.42);
  const tealMaterial = material("Desaturated patina", 0x4d9b9a, 0.38, 0.05);
  const metalMaterial = material("Brushed sun metal", 0xc09a5b, 0.3, 0.68);
  const meshes: Mesh[] = [];
  let triangles = 0;

  const addBox = (
    name: string,
    size: readonly [number, number, number],
    position: readonly [number, number, number],
    materialValue: StandardShadeMaterial
  ): Mesh => {
    const mesh = Mesh.from(
      new BoxGeometry(size[0] * SCENE_SCALE, size[1] * SCENE_SCALE, size[2] * SCENE_SCALE),
      materialValue
    );
    mesh.name = name;
    mesh.position.set(
      position[0] * SCENE_SCALE,
      position[1] * SCENE_SCALE,
      position[2] * SCENE_SCALE
    );
    scene.add(mesh);
    meshes.push(mesh);
    triangles += 12;
    return mesh;
  };

  const ground = Mesh.from(createGroundGeometry(), groundMaterial);
  ground.name = "Mesa Commons ground";
  scene.add(ground);
  meshes.push(ground);
  triangles += 2;

  addBox("Central plinth", [36, 3, 28], [0, 1.5, 0], platformMaterial);
  addBox("North ridge", [14, 9, 7], [-8, 7.5, -8], basaltMaterial);
  addBox("South ridge", [18, 6, 9], [10, 6, 10], basaltMaterial);
  addBox("West sun wall", [4, 13, 28], [-30, 6.5, 2], platformMaterial);

  const pillars: readonly [number, number, number, number][] = [
    [-24, 8, -24, 0], [24, 12, -22, 0], [-28, 5, 26, 0], [27, 9, 24, 0],
    [-8, 18, -3, 1], [8, 24, 4, 1], [18, 14, -2, 1]
  ];
  for (const [x, height, z, variant] of pillars) {
    addBox(
      variant === 0 ? "Shadow pillar" : "Sun fin",
      variant === 0 ? [3.2, height, 3.2] : [2.2, height, 7],
      [x, height / 2, z],
      variant === 0 ? basaltMaterial : (variant % 2 === 0 ? ceramicMaterial : tealMaterial)
    );
  }

  const sphereGeometry = createLowPolySphere(5 * SCENE_SCALE);
  for (const [name, position, materialValue] of [
    ["Red sun stone", [-13, 8, 5], ceramicMaterial],
    ["Teal sun stone", [14, 8, -8], tealMaterial],
    ["Metal sun stone", [0, 11, 2], metalMaterial]
  ] as const) {
    const mesh = Mesh.from(sphereGeometry, materialValue);
    mesh.name = name;
    mesh.position.set(
      position[0] * SCENE_SCALE,
      position[1] * SCENE_SCALE,
      position[2] * SCENE_SCALE
    );
    scene.add(mesh);
    meshes.push(mesh);
    triangles += sphereGeometry.primitive_count;
  }

  let applied: SkySceneSettings | undefined;
  const apply = (settings: SkySceneSettings): void => {
    if (
      !applied ||
      applied.sunAzimuth !== settings.sunAzimuth ||
      applied.sunElevation !== settings.sunElevation ||
      applied.sunScale !== settings.sunScale ||
      applied.skyScale !== settings.skyScale ||
      applied.aerial !== settings.aerial ||
      applied.lightingView !== settings.lightingView
    ) {
      applyEnvironment(scene, settings);
    }
    applied = { ...settings };
  };
  apply({ ...SKY_SCENE_DEFAULTS });

  return {
    scene,
    apply,
    metadata: Object.freeze({
      sceneName: "Mesa Commons",
      units: "metres",
      groundHalfExtentMetres: GROUND_HALF_EXTENT,
      sceneScale: SCENE_SCALE,
      instances: meshes.length,
      triangles
    })
  };
}
