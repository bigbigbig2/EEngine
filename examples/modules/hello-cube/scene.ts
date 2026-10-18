import {
  BoxGeometry,
  DirectionalLight,
  Mesh,
  Scene,
  StandardShadeMaterial
} from "../../../OEngine/src/index.ts";

const GROUND_SIZE = 10;
const GROUND_HEIGHT = 0.18;
const CUBE_SIZE = 2;

function material(
  name: string,
  color: readonly [number, number, number],
  roughness: number,
  metallic = 0
): StandardShadeMaterial {
  const value = new StandardShadeMaterial();
  value.name = name;
  value.diffuse_color.set(color[0], color[1], color[2], 1);
  value.roughness_factor = roughness;
  value.metallic_factor = metallic;
  return value;
}

export function createBasicCubeScene(): {
  scene: Scene;
  metadata: Readonly<{
    sceneName: string;
    instances: number;
    triangles: number;
    geometryPath: string;
    light: string;
  }>;
} {
  const scene = new Scene();
  const groundMaterial = material("Warm gray ground", [0.34, 0.37, 0.38], 0.92);
  const cubeMaterial = material("Cobalt blue cube", [0.12, 0.32, 0.78], 0.42);

  const ground = Mesh.from(
    new BoxGeometry(GROUND_SIZE, GROUND_HEIGHT, GROUND_SIZE),
    groundMaterial
  );
  ground.name = "Small ground";
  ground.position.y = -GROUND_HEIGHT * 0.5;
  ground.castShadow = false;
  ground.receiveShadow = false;

  const cube = Mesh.from(new BoxGeometry(CUBE_SIZE, CUBE_SIZE, CUBE_SIZE), cubeMaterial);
  cube.name = "Center cube";
  cube.position.y = CUBE_SIZE * 0.5;
  cube.castShadow = false;
  cube.receiveShadow = false;

  const keyLight = new DirectionalLight();
  keyLight.name = "Key directional light";
  keyLight.color.set(1, 0.96, 0.9, 1);
  keyLight.intensity = 3.2;
  keyLight.casts_shadow = false;
  keyLight.transform_local.position.set(4, 7, -5);
  keyLight.transform_local.lookAt({ x: 0, y: 0, z: 0 });
  keyLight.updateMatrices();

  scene.add([ground, cube, keyLight]);

  return {
    scene,
    metadata: Object.freeze({
      sceneName: "Hello Cube",
      instances: 2,
      triangles: ground.geometry.primitive_count + cube.geometry.primitive_count,
      geometryPath: "GeometryProduct V1 -> Virtual Geometry",
      light: "authored DirectionalLight"
    })
  };
}
