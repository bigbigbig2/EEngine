import type { ImageKernelSource } from "../../OEngine/src/gpu/ImageTextureTranscoder.ts";

/** Local evaluation source only; the validation host does not distribute kernels. */
export async function validationImageKernels(): Promise<ImageKernelSource> {
  const response = await fetch("/__image-kernels/identity.json");
  if (!response.ok) throw new Error("Validation image kernel identity is unavailable");
  const identity = await response.json();
  if (identity.revision !== "b9ea643a08cb9eef3a9ddc64564089bdd6fd0daf" ||
      identity.scope !== "local-evaluation") {
    throw new Error("Validation requires the pinned local evaluation kernel source");
  }
  const shaders = {} as Record<keyof ImageKernelSource["shaders"], string>;
  for (const name of ["bc7-rgb", "bc7-rgba", "bc5-rg", "bc4-r", "utils"] as const) {
    const response = await fetch(`/__image-kernels/${name}.wgsl`);
    if (!response.ok) throw new Error(`Missing validation kernel ${name}`);
    const bytes = await response.arrayBuffer();
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    const hash = [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    if (hash !== identity.hashes[name]) throw new Error(`Validation kernel hash mismatch: ${name}`);
    shaders[name] = new TextDecoder().decode(bytes);
  }
  document.body.prepend(Object.assign(document.createElement("small"), {
    textContent: "Powered by spark.js - local evaluation; https://ludicon.com/sparkjs/eula.html"
  }));
  return { revision: identity.revision, scope: identity.scope, shaders };
}
