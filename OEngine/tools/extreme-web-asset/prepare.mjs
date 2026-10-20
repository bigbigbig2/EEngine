import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, cp, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const output = join(root, ".local/extreme-web-asset");
const sourceRoot = join(output, "sources");
const prefix = join(output, "native");
const manifest = JSON.parse(await readFile(new URL("./sources.json", import.meta.url), "utf8"));
const mode = process.argv[2] ?? "fetch";
const runStamp = new Date().toISOString().replaceAll(/[^0-9]/g, "");
if (!["fetch", "build"].includes(mode)) {
  throw new Error("Usage: node OEngine/tools/extreme-web-asset/prepare.mjs fetch|build");
}
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const portable = (path) => relative(root, path).replaceAll("\\", "/");
await mkdir(output, { recursive: true });
await mkdir(sourceRoot, { recursive: true });
await mkdir(join(output, "logs"), { recursive: true });
const commands = [];
function run(command, args, cwd = root, capture = false) {
  commands.push({ command, args, cwd: portable(cwd) });
  const result = spawnSync(command, args, {
    cwd, windowsHide: true, encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
  });
  if (!capture || result.status !== 0) {
    const name = `${runStamp}-${String(commands.length).padStart(3, "0")}-${command.replaceAll(/[^a-z0-9-]/gi, "_")}.log`;
    // Write each process log before surfacing failure; no success manifest on a failed build.
    return writeFile(join(output, "logs", name), `${result.stdout ?? ""}\n${result.stderr ?? ""}`).then(() => {
      if (result.status !== 0) throw new Error(`${command} failed (${result.status}): ${result.error ?? name}`);
      return result.stdout;
    });
  }
  return Promise.resolve(result.stdout);
}

for (const [name, source] of Object.entries(manifest.sources)) {
  const directory = join(sourceRoot, name);
  if (!existsSync(join(directory, ".git"))) {
    if (existsSync(directory)) throw new Error(`Refusing to overwrite non-checkout: ${directory}`);
    await run("git", ["init", directory]);
    await run("git", ["remote", "add", "origin", source.url], directory);
  }
  let revision = await run("git", ["rev-parse", "--verify", "HEAD"], directory, true).catch(() => "");
  if (!revision.trim()) {
    await run("git", ["fetch", "--depth=1", "origin", source.ref], directory);
    await run("git", ["checkout", "--detach", "FETCH_HEAD"], directory);
    revision = await run("git", ["rev-parse", "HEAD"], directory, true);
  }
  if (revision.trim() !== source.revision) throw new Error(`${name}: revision mismatch`);
  if ((await run("git", ["status", "--porcelain", "--untracked-files=no"], directory, true)).trim()) {
    throw new Error(`${name}: modified tracked source`);
  }
  console.log(`${name}: ${source.revision}`);
}

const sources = {};
for (const [name, source] of Object.entries(manifest.sources)) {
  const directory = join(sourceRoot, name);
  const files = (await run("git", ["ls-files"], directory, true)).trim().split("\n");
  const identities = {};
  // Includes complete tracked source identity, not only the files used by one build.
  const tree = createHash("sha256");
  for (const file of files) {
    const digest = hash(await readFile(join(directory, file)));
    tree.update(`${file}\0${digest}\n`);
    if (/license|copying|patents|notice/i.test(file) ||
        (name === "spark" && /^(src\/|LICENSE)/.test(file)) ||
        (name === "gltf-tex" && /^(src\/processors\/avif.js|package.json|README.md)$/.test(file))) identities[file] = digest;
  }
  sources[name] = { ...source, path: portable(directory), trackedTreeSha256: tree.digest("hex"), files: identities };
}
const legalPages = {};
await mkdir(join(output, "licenses"), { recursive: true });
for (const [name, url] of Object.entries({ sparkEula: "https://ludicon.com/sparkjs/eula.html", sparkCommercial: "https://ludicon.com/sparkjs/license.html" })) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const path = join(output, "licenses", `${name}.html`);
  await writeFile(path, bytes);
  legalPages[name] = { url, sha256: hash(bytes), path: portable(path), retrievedAt: new Date().toISOString() };
}
await writeFile(join(output, "sources.json"), JSON.stringify({ sources, legalPages }, null, 2) + "\n");
if (mode === "build") {

if (process.platform !== "win32") throw new Error("This native preparation recipe currently targets Windows x64 MSVC.");
const archive = join(output, "downloads/nasm-2.16.03-win64.zip");
await mkdir(join(output, "downloads"), { recursive: true });
if (!existsSync(archive)) {
  const response = await fetch(manifest.nasm.url);
  if (!response.ok) throw new Error(`NASM: ${response.status}`);
  await writeFile(archive, Buffer.from(await response.arrayBuffer()));
}
if (hash(await readFile(archive)) !== manifest.nasm.sha256) throw new Error("NASM archive hash mismatch");
const nasmRoot = join(output, "nasm");
if (!existsSync(join(nasmRoot, "nasm-2.16.03/nasm.exe"))) {
  const quote = (value) => "'" + value.replaceAll("'", "''") + "'";
  await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    `Expand-Archive -LiteralPath ${quote(archive)} -DestinationPath ${quote(nasmRoot)}`]);
}
process.env.PATH = join(nasmRoot, "nasm-2.16.03") + ";" + process.env.PATH;
const generator = ["-G", "Visual Studio 18 2026", "-A", "x64"];
const common = ["-DCMAKE_POLICY_VERSION_MINIMUM=3.5", `-DCMAKE_INSTALL_PREFIX=${prefix}`, "-DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreadedDLL"];
const gitExecutable = (await run("where.exe", ["git.exe"], root, true)).trim().split(/\r?\n/)[0];
const perl = process.env.EENGINE_PERL ?? join(gitExecutable, "../../usr/bin/perl.exe");
if (!existsSync(perl)) throw new Error("Set EENGINE_PERL to Perl for libaom's upstream code generators.");
const recipes = [
  ["zlib", ["-DZLIB_BUILD_EXAMPLES=OFF"]],
  ["libpng", ["-DPNG_SHARED=OFF", "-DPNG_TESTS=OFF", "-DPNG_TOOLS=OFF", "-DPNG_EXECUTABLES=OFF", "-DZLIB_USE_STATIC_LIBS=ON"]],
  ["jpeg", ["-DENABLE_SHARED=OFF", "-DENABLE_STATIC=ON", "-DWITH_TURBOJPEG=OFF", "-DWITH_CRT_DLL=ON"]],
  ["aom", [`-DPERL_EXECUTABLE=${perl}`, "-DBUILD_SHARED_LIBS=OFF", "-DENABLE_TESTS=OFF", "-DENABLE_EXAMPLES=OFF", "-DENABLE_TOOLS=OFF", "-DENABLE_DOCS=OFF", "-DCONFIG_AV1_ENCODER=1", "-DCONFIG_AV1_DECODER=1"]],
  ["libavif", ["-DBUILD_SHARED_LIBS=OFF", "-DAVIF_BUILD_APPS=ON", "-DAVIF_BUILD_TESTS=OFF", "-DAVIF_CODEC_AOM=SYSTEM", "-DAVIF_CODEC_DAV1D=OFF", "-DAVIF_CODEC_LIBGAV1=OFF", "-DAVIF_CODEC_RAV1E=OFF", "-DAVIF_CODEC_SVT=OFF", "-DAVIF_LIBYUV=OFF", "-DAVIF_ZLIBPNG=SYSTEM", "-DAVIF_JPEG=SYSTEM", "-DZLIB_USE_STATIC_LIBS=ON", `-DJPEG_LIBRARY=${prefix}/lib/jpeg-static.lib`]],
];
const startedAt = new Date().toISOString();
for (const [name, flags] of recipes) {
  console.log(`Configuring/building ${name}...`);
  const build = join(output, "build", name === "zlib" ? "zlib-isolated" : name);
  let buildSource = join(sourceRoot, name);
  // Upstream zlib CMake renames tracked zconf.h. Keep that build mutation out of the pinned checkout.
  if (name === "zlib") {
    buildSource = join(output, "build-sources", name);
    if (!existsSync(buildSource)) await cp(join(sourceRoot, name), buildSource, { recursive: true, filter: (path) => !path.endsWith(".git") });
    const files = (await run("git", ["ls-files"], join(sourceRoot, name), true)).trim().split("\n");
    for (const file of files) {
      const copied = file === "zconf.h" && !existsSync(join(buildSource, file)) ? "zconf.h.included" : file;
      if (hash(await readFile(join(buildSource, copied))) !== hash(await readFile(join(sourceRoot, name, file)))) {
        throw new Error(`zlib build-source mismatch: ${file}`);
      }
    }
  }
  await run("cmake", ["-S", buildSource, "-B", build, ...generator, ...common, `-DCMAKE_PREFIX_PATH=${prefix}`, ...flags]);
  await run("cmake", ["--build", build, "--config", "Release", "--target", "INSTALL", "--parallel", "4"]);
}
const binaries = {};
for (const name of ["avifenc.exe", "avifdec.exe"]) {
  const path = join(prefix, "bin", name);
  binaries[name] = { path: portable(path), sha256: hash(await readFile(path)), version: (await run(path, ["--version"], root, true)).trim() };
}
const caches = {};
for (const [name] of recipes) caches[name] = hash(await readFile(join(output, "build", name === "zlib" ? "zlib-isolated" : name, "CMakeCache.txt")));
const compilerFile = join(output, "build/libavif/CMakeFiles", (await run("cmake", ["--version"], root, true)).match(/version (\S+)/)[1], "CMakeCCompiler.cmake");
const compilerConfiguration = await readFile(compilerFile, "utf8");
const compilerPath = compilerConfiguration.match(/set\(CMAKE_C_COMPILER "([^"]+)"\)/)?.[1];
if (!compilerPath) throw new Error("Compiler identity missing");
const notices = {};
for (const [name, source] of Object.entries(sources)) {
  for (const [file, sha256] of Object.entries(source.files)) {
    if (/license|copying|patents|notice/i.test(file)) {
      const path = join(output, "licenses", name, file);
      await mkdir(join(path, ".."), { recursive: true });
      await writeFile(path, await readFile(join(sourceRoot, name, file)));
      notices[`${name}/${file}`] = sha256;
    }
  }
}
for (const [name, source] of Object.entries(manifest.sources)) {
  const directory = join(sourceRoot, name);
  if ((await run("git", ["status", "--porcelain", "--untracked-files=no"], directory, true)).trim()) throw new Error(`${name}: build changed pinned source`);
}
await writeFile(join(output, "native-build.json"), JSON.stringify({ startedAt, completedAt: new Date().toISOString(),
  recipeSha256: hash(await readFile(fileURLToPath(import.meta.url))), sourceManifestSha256: hash(await readFile(new URL("./sources.json", import.meta.url))),
  sourceIdentitySha256: hash(await readFile(join(output, "sources.json"))), cmake: (await run("cmake", ["--version"], root, true)).trim(),
  compiler: { path: compilerPath, sha256: hash(await readFile(compilerPath)), configurationSha256: hash(compilerConfiguration), version: compilerConfiguration.match(/set\(CMAKE_C_COMPILER_VERSION "([^"]+)"\)/)?.[1] },
  nasm: manifest.nasm, perl: { path: perl, sha256: hash(await readFile(perl)), version: (await run(perl, ["-v"], root, true)).trim() }, sources, notices, commands, caches, binaries }, null, 2) + "\n");
console.log(JSON.stringify(binaries, null, 2));
}
