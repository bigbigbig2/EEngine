import { access, mkdir, readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, extname, resolve } from "node:path";

const [, , inputArgument, outputArgument, ...argumentsAfterOutput] = process.argv;
if (!inputArgument || !outputArgument) {
  throw new Error(
    "usage: npm run cook:gltf:ktx2 -- <input.gltf|glb> <output.glb> [--uastc] [gltfpack options]"
  );
}

const input = resolve(inputArgument);
const output = resolve(outputArgument);
await access(input);
await mkdir(dirname(output), { recursive: true });

const uastc = argumentsAfterOutput.includes("--uastc");
const forwarded = argumentsAfterOutput.filter((argument) => argument !== "--uastc");
const executable = process.env.OENGINE_GLTFPACK_BIN || "gltfpack";
const args = ["-i", input, "-o", output, uastc ? "-tu" : "-tc", ...forwarded];
const exitCode = await new Promise((resolveExit, reject) => {
  const child = spawn(executable, args, { stdio: "inherit", windowsHide: true });
  child.once("error", reject);
  child.once("exit", (code, signal) => {
    if (signal) reject(new Error(`gltfpack terminated by ${signal}`));
    else resolveExit(code ?? 1);
  });
});
if (exitCode !== 0) throw new Error(`gltfpack exited with code ${exitCode}`);

if (extname(output).toLowerCase() === ".gltf") {
  const document = JSON.parse(await readFile(output, "utf8"));
  const hasBasis = document.extensionsUsed?.includes("KHR_texture_basisu") ||
    document.textures?.some((texture) => texture.extensions?.KHR_texture_basisu);
  if (!hasBasis) throw new Error("Cooked glTF contains no KHR_texture_basisu textures");
}
