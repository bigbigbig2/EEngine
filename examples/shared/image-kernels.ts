import type { ImageKernelSource } from "../../OEngine/src/gpu/ImageTextureTranscoder.ts";

/** Evaluation examples use locally fetched upstream source, never a public CDN
 * fallback. Deployments must supply kernels under their applicable Spark rights. */
export async function exampleImageKernels(): Promise<ImageKernelSource> {
  const response = await fetch("/__image-kernels/identity.json");
  if (!response.ok) throw new Error("Image kernels unavailable: prepare local Spark sources or configure authorized deployment kernels");
  const identity = await response.json();
  if (identity.revision !== "b9ea643a08cb9eef3a9ddc64564089bdd6fd0daf" ||
      !["local-evaluation", "authorized-production"].includes(identity.scope)) {
    throw new Error("Example image kernel profile mismatch");
  }
  const shaders = {} as Record<keyof ImageKernelSource["shaders"], string>;
  for (const name of ["bc7-rgb", "bc7-rgba", "bc5-rg", "bc4-r", "utils"] as const) {
    const source = await fetch(`/__image-kernels/${name}.wgsl`);
    if (!source.ok) throw new Error(`Missing explicitly configured image kernel ${name}`);
    const bytes = await source.arrayBuffer();
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    const hash = [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
    if (hash !== identity.hashes[name]) throw new Error("Example image kernel hash mismatch");
    shaders[name] = new TextDecoder().decode(bytes);
  }
  const attribution = document.createElement("small");
  attribution.textContent = "Powered by spark.js - https://ludicon.com/sparkjs/eula.html";
  attribution.style.cssText = "position:fixed;bottom:4px;left:6px;font-size:10px;z-index:10";
  document.body.append(attribution);
  return { revision: identity.revision, scope: identity.scope, shaders };
}
