/**
 * load_scene_from_url：负责资源读取、解码或场景装载。
 */

import type { Scene } from "../scene/Scene.js";
import { BinaryReader } from "./BinaryReader.js";
import { deserialize_scene } from "./deserialize_scene.js";

export async function load_scene_from_url(
  url: string,
  scene: Scene
): Promise<Scene> {
  const n = await fetch(url);
  if (!n.ok) {
    throw new Error(`Failed to fetch scene: ${n.status} ${n.statusText}`);
  }
  const r = await n.arrayBuffer();
  return deserialize_scene(BinaryReader.fromArrayBuffer(r), scene);
}
