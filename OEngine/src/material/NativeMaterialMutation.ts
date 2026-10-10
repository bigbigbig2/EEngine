import type { StandardShadeMaterial } from "./StandardShadeMaterial.js";

type Listener = () => void;
interface FieldObserver {
  value: unknown;
  readonly listeners: Set<Listener>;
}
const observed = new WeakMap<object, Map<string, FieldObserver>>();

/** Cold admission installs setters on authored fields. Direct edits retain their
 * API; shared Colors/materials notify every live scene without a frame scan.
 * Frozen objects need no observer. Borrowers detach on scene retirement/loss. */
function observeField(object: object, key: string, changed: Listener): Listener {
  let fields = observed.get(object);
  let state = fields?.get(key);
  if (!state) {
    if (Object.isFrozen(object)) return () => undefined;
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    if (!descriptor || !descriptor.configurable || !("value" in descriptor))
      throw new TypeError(`Native material field '${key}' requires an observable data property`);
    state = { value: descriptor.value, listeners: new Set() };
    const field = state;
    Object.defineProperty(object, key, {
      enumerable: descriptor.enumerable,
      configurable: true,
      get: () => field.value,
      set: (value: unknown) => {
        if (Object.is(value, field.value)) return;
        field.value = value;
        for (const listener of field.listeners) listener();
      },
    });
    if (!fields) {
      fields = new Map();
      observed.set(object, fields);
    }
    fields.set(key, state);
  }
  state.listeners.add(changed);
  return () => {
    state.listeners.delete(changed);
  };
}

export function observeNativeMaterial(material: StandardShadeMaterial, changed: Listener): Listener {
  const release: Listener[] = [];
  for (const key of [
    "is_unlit",
    "transparency_mode",
    "alpha_cutoff",
    "texture_emissive",
    "normal_scale",
    "roughness_factor",
    "metallic_factor",
    "ior_factor",
    "specular_factor",
    "clearcoat_factor",
    "clearcoat_roughness_factor",
    "clearcoat_normal_scale",
  ])
    release.push(observeField(material, key, changed));
  for (const [key, components] of [
    ["diffuse_color", ["r", "g", "b", "a"]],
    ["emissive_factor", ["r", "g", "b"]],
    ["specular_color_factor", ["r", "g", "b"]],
    ["ambient_factors", ["a"]],
  ] as const) {
    let detach: Listener[] = [];
    const attach = () => {
      detach.forEach((callback) => callback());
      const value = material[key];
      detach = components.map((component) => observeField(value, component, changed));
    };
    attach();
    release.push(
      observeField(material, key, () => {
        attach();
        changed();
      }),
    );
    release.push(() => detach.forEach((callback) => callback()));
  }
  release.push(material.appearance_inputs.onChanged.subscribe(changed));
  return () => release.forEach((callback) => callback());
}
