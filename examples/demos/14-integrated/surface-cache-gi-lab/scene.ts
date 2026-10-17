import {
  BoxGeometry,
  Mesh,
  PointLight,
  Scene,
  StandardShadeMaterial
} from "../../../../OEngine/src/index.ts";
import { Attribute } from "../../../../OEngine/src/geometry/Attribute.ts";
import { MeshletGeometryBase } from "../../../../OEngine/src/geometry/BoxGeometry.ts";
import { Geometry } from "../../../../OEngine/src/geometry/Geometry.ts";
import { MeshletAttrName } from "../../../../OEngine/src/geometry/meshletPackedAttrs.ts";
import { niFromGeometry } from "../../../../OEngine/src/geometry/niMeshlets.ts";

type Triple = readonly [number, number, number];

export const CAMERAS = {
  main: { label: "01 主厅 → 暗室", eye: [-4.25, 1.65, 3.15], target: [0.4, 1.1, -1.15] },
  dark: { label: "02 暗室 → 门缝", eye: [4.25, 1.6, -3.25], target: [-1.7, 1.05, -0.5] },
  corridor: { label: "03 L 形走廊", eye: [0.7, 1.55, 3.35], target: [4.1, 1.15, 0.3] },
  emissive: { label: "04 自发光角落", eye: [4.65, 1.5, -1.4], target: [3.9, 1.1, -3.55] },
  contact: { label: "05 桌腿 / 薄隔板", eye: [-1.2, 0.65, 1.6], target: [-2.8, 0.6, -0.55] },
  window: { label: "06 窗口 / 彩色墙", eye: [-0.7, 1.7, 2.8], target: [-4.4, 1.25, -1.7] },
  overview: { label: "07 室内广角总览", eye: [-4.6, 2.85, 3.55], target: [-0.4, 0.85, -0.7] }
} as const;
export type CameraName = keyof typeof CAMERAS;
export type ExperimentName = "sun" | "door" | "color" | "emitter" | "blocker" | "contact";

export interface SceneParameters {
  door: number;
  shutter: number;
  blocker: number;
  emitterX: number;
  emission: number;
  sun: number;
  sunElevation: number;
  sunAzimuth: number;
  sky: number;
  point: number;
  coloredWalls: boolean;
  roughness: number;
}

export const SCENE_DEFAULTS: Readonly<SceneParameters> = Object.freeze({
  door: 1,
  shutter: 1,
  blocker: 0,
  emitterX: 0,
  emission: 0,
  sun: 3,
  sunElevation: 28,
  sunAzimuth: -100,
  sky: 0.15,
  point: 0,
  coloredWalls: true,
  roughness: 0.85
});

export const EXPERIMENTS: Record<
  ExperimentName,
  { label: string; camera: CameraName; parameters: Partial<SceneParameters>; purpose: string }
> = {
  sun: {
    label: "窗口日光",
    camera: "main",
    parameters: {},
    purpose: "观察窗口直射与红绿墙反弹。关闭窗遮板后检查室内间接光的衰减。"
  },
  door: {
    label: "门开合 · 跨房间",
    camera: "dark",
    parameters: { door: 0, emission: 0, sky: 0.05 },
    purpose: "从暗室观察门开合后的光照传播、历史响应与漏光。播放时门按固定周期平移。"
  },
  color: {
    label: "彩色反弹 / 多跳",
    camera: "window",
    parameters: { coloredWalls: true, sky: 0.05 },
    purpose: "比较彩色墙与中性墙、单跳与多跳。保持曝光一致，检查白色接收面的色彩传递。"
  },
  emitter: {
    label: "移动自发光",
    camera: "emissive",
    parameters: { sun: 0, sky: 0, emission: 18 },
    purpose: "没有附加点光源。黑色基底发光片真实参与 GI；观察移动、熄灭后的响应和残留。"
  },
  blocker: {
    label: "拐角 / 离屏遮挡",
    camera: "corridor",
    parameters: { emission: 18, sun: 0, sky: 0, blocker: 0 },
    purpose: "观察 L 形走廊拐角与离屏光源。移动挡板后检查遮挡变化，不能把缓存缺覆盖当作黑色真值。"
  },
  contact: {
    label: "近场残差 / 接触",
    camera: "contact",
    parameters: { sky: 0.05 },
    purpose: "检查桌腿、细杆、薄隔板附近。比较最终画面、world-only appearance 和 signed residual。"
  }
};

function material(name: string, color: Triple, metallic = 0, roughness = 0.85): StandardShadeMaterial {
  const value = new StandardShadeMaterial();
  value.name = name;
  value.diffuse_color.set(...color, 1);
  value.metallic_factor = metallic;
  value.roughness_factor = roughness;
  return value;
}

/** A small UV sphere, cooked through the same GeometryProduct path as boxes. */
function sphere(radius: number): MeshletGeometryBase {
  const positions: number[] = [];
  const normals: number[] = [];
  const uv: number[] = [];
  const indices: number[] = [];
  const columns = 20;
  const rows = 12;
  for (let row = 0; row <= rows; row++) {
    const phi = (row / rows) * Math.PI;
    for (let column = 0; column <= columns; column++) {
      const theta = (column / columns) * Math.PI * 2;
      const normal = [Math.sin(phi) * Math.cos(theta), Math.cos(phi), Math.sin(phi) * Math.sin(theta)];
      positions.push(...normal.map((value) => value * radius));
      normals.push(...normal);
      uv.push(column / columns, row / rows);
    }
  }
  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < columns; column++) {
      const a = row * (columns + 1) + column;
      const b = a + columns + 1;
      if (row > 0) {
        indices.push(a, a + 1, b);
      }
      if (row < rows - 1) {
        indices.push(a + 1, b + 1, b);
      }
    }
  }
  const geometry = new Geometry();
  geometry.name = "Lab UV sphere";
  geometry.index = Attribute.from(new Uint32Array(indices), 1, "index");
  geometry.addAttribute(Attribute.from(new Float32Array(positions), 3, MeshletAttrName.Position));
  geometry.addAttribute(Attribute.from(new Float32Array(normals), 3, MeshletAttrName.Normal));
  geometry.addAttribute(Attribute.from(new Float32Array(uv), 2, MeshletAttrName.Uv0));
  return niFromGeometry(geometry, new MeshletGeometryBase());
}

export function createLabScene() {
  const scene = new Scene();
  const chalk = material("Chalk · linear reflectance 0.72", [0.72, 0.72, 0.72]);
  const gray = material("Neutral trim", [0.23, 0.25, 0.28]);
  const red = material("Red bounce wall", [0.72, 0.035, 0.022]);
  const green = material("Green bounce panel", [0.035, 0.58, 0.065]);
  const black = material("Black absorber", [0.025, 0.025, 0.025]);
  const emission = material("Movable emitter · black base", [0, 0, 0]);
  const porcelain = material("Dielectric sphere", [0.65, 0.65, 0.65], 0, 0.35);
  const metal = material("Metal sphere · specular control", [0.85, 0.85, 0.85], 1, 0.22);
  const meshes: Mesh[] = [];
  let triangles = 0;
  const box = (name: string, size: Triple, position: Triple, value = chalk) => {
    const mesh = Mesh.from(new BoxGeometry(...size), value);
    mesh.name = name;
    mesh.position.set(...position);
    scene.add(mesh);
    meshes.push(mesh);
    triangles += 12;
    return mesh;
  };

  // Metres. Floor/ceiling and every partition have thickness, including closed
  // door and window. No cutaway rendering: the overview camera stays indoors.
  box("House floor", [10.4, 0.2, 8.4], [0, -0.1, 0]);
  box("House ceiling", [10.4, 0.2, 8.4], [0, 3.3, 0]);
  box("North exterior", [10.4, 3.2, 0.2], [0, 1.6, -4.1]);
  box("South exterior", [10.4, 3.2, 0.2], [0, 1.6, 4.1]);
  box("East exterior", [0.2, 3.2, 8], [5.1, 1.6, 0]);
  // West window opening: z [-2, 1.2], y [0.8, 2.65].
  box("West wall north", [0.2, 3.2, 2], [-5.1, 1.6, -3], red);
  box("West wall south", [0.2, 3.2, 2.8], [-5.1, 1.6, 2.6]);
  box("Window sill wall", [0.2, 0.8, 3.2], [-5.1, 0.4, -0.4]);
  box("Window lintel wall", [0.2, 0.55, 3.2], [-5.1, 2.925, -0.4]);
  const shutter = box("Sliding window shutter", [0.12, 1.9, 3.3], [-5.25, 1.725, -0.4], gray);
  box("Outside ground", [3.5, 0.2, 6], [-7, -0.12, -0.6], gray);
  // Partition x=0. Door aperture z [-1.6, 0.2], height 2.35m.
  box("Partition north", [0.2, 3.2, 2.4], [0, 1.6, -2.8]);
  box("Partition south", [0.2, 3.2, 3.8], [0, 1.6, 2.1]);
  box("Door lintel", [0.2, 0.85, 1.8], [0, 2.775, -0.7]);
  const door = box("Rigid sliding door", [0.16, 2.4, 1.85], [0.02, 1.175, -0.7], gray);
  // Dark room to corridor: aperture at eastern end makes an L-shaped route.
  box("Corridor return", [3.45, 3.2, 0.2], [1.825, 1.6, 0.65]);
  box("Corridor overhead", [1.45, 0.85, 0.2], [4.275, 2.775, 0.65]);
  const blocker = box("Moving corridor blocker", [1.5, 2.4, 0.16], [4.25, 1.2, 0.65], black);
  // Alcove around emissive panel. The opening faces the dark room.
  box("Alcove side", [0.18, 2.4, 1.5], [3.05, 1.2, -3.25], gray);
  box("Alcove canopy", [2, 0.15, 1.5], [4, 2.4, -3.25]);
  const emitter = box("Movable warm emitter", [0.85, 1.1, 0.1], [4, 1.2, -3.85], emission);
  box("Alcove receiver", [0.8, 0.5, 0.8], [4.1, 0.25, -2.8]);
  box("Dark room receiver", [1.2, 0.65, 0.85], [1.75, 0.325, -2.2]);
  box("Color patch green", [0.08, 1.8, 2.1], [-0.2, 1.2, -2.7], green);
  box("Color patch red", [1.6, 1.9, 0.06], [-3.6, 1.2, -3.96], red);
  // Table / contact set; intersecting legs deliberately make real contact.
  box("Table top", [1.9, 0.12, 1.25], [-2.8, 0.97, -0.55]);
  for (const x of [-3.55, -2.05]) {
    for (const z of [-1.02, -0.08]) {
      box("Table leg", [0.1, 0.94, 0.1], [x, 0.47, z], gray);
    }
  }
  box("Thin near-field partition", [0.055, 0.75, 0.8], [-1.5, 0.375, -0.8]);
  for (let index = 0; index < 5; index++) {
    box("Fine occluder", [0.045, 0.65, 0.09], [-3.7 + index * 0.13, 0.325, 1.15], gray);
  }
  box("Bounce pedestal", [1, 0.4, 0.9], [-3.9, 0.2, -2.85]);
  for (const [x, value] of [
    [-3.25, porcelain],
    [-2.4, metal]
  ] as const) {
    const mesh = Mesh.from(sphere(0.3), value);
    mesh.name = value.name;
    mesh.position.set(x, 1.33, -0.55);
    scene.add(mesh);
    meshes.push(mesh);
    triangles += 440;
  }
  const point = new PointLight();
  point.position.set(-3.25, 2.6, -0.7);
  point.distance = 18;
  point.intensity = 0;
  point.casts_shadow = true;
  scene.add(point);
  scene.physical_environment.setLightingDiagnostic("all", false);
  let applied: SceneParameters | undefined;

  function apply(parameters: SceneParameters): void {
    door.position.y = 1.175 + parameters.door * 2.6;
    shutter.position.y = 1.725 + parameters.shutter * 2.2;
    blocker.position.x = 6.1 - parameters.blocker * 1.85;
    emitter.position.x = 4 + parameters.emitterX;
    if (!applied || applied.emission !== parameters.emission) {
      emission.emissive_factor.set(
        parameters.emission,
        parameters.emission * 0.32,
        parameters.emission * 0.065
      );
    }
    if (!applied || applied.coloredWalls !== parameters.coloredWalls) {
      red.diffuse_color.set(
        0.72,
        parameters.coloredWalls ? 0.035 : 0.72,
        parameters.coloredWalls ? 0.022 : 0.72,
        1
      );
      green.diffuse_color.set(
        parameters.coloredWalls ? 0.035 : 0.72,
        parameters.coloredWalls ? 0.58 : 0.72,
        parameters.coloredWalls ? 0.065 : 0.72,
        1
      );
    }
    if (!applied || applied.roughness !== parameters.roughness) {
      chalk.roughness_factor = parameters.roughness;
    }
    if (!applied || applied.point !== parameters.point) {
      point.intensity = parameters.point;
    }
    if (
      !applied ||
      applied.sun !== parameters.sun ||
      applied.sunAzimuth !== parameters.sunAzimuth ||
      applied.sunElevation !== parameters.sunElevation
    ) {
      const elevation = (parameters.sunElevation * Math.PI) / 180;
      const azimuth = (parameters.sunAzimuth * Math.PI) / 180;
      scene.physical_environment.setSun(
        [
          Math.sin(azimuth) * Math.cos(elevation),
          Math.sin(elevation),
          Math.cos(azimuth) * Math.cos(elevation)
        ],
        [parameters.sun, parameters.sun * 0.93, parameters.sun * 0.82]
      );
    }
    if (!applied || applied.sky !== parameters.sky) {
      scene.physical_environment.setSkyLuminanceScale(parameters.sky);
    }
    applied = { ...parameters };
  }

  apply({ ...SCENE_DEFAULTS });
  return {
    scene,
    apply,
    metadata: {
      units: "metres",
      rooms: ["main", "dark", "L corridor", "emissive alcove"],
      instances: meshes.length,
      triangles,
      geometry: "Procedural boxes + UV spheres; one cooked GeometryProduct upload",
      materialColors: "Linear RGB reflectance; no baked illumination or auxiliary emitter lights"
    }
  };
}
