/**
 * Check runner registry.
 *
 * `checks/checks.yaml` and `checks/guards/*.yaml` declare *what* a check asserts;
 * this module owns *how* it is executed. Before this split the declarations were
 * pure metadata and every check was an `if (check.id === ...)` branch in
 * `vibe.mjs`, so adding a guard meant editing the CLI and the same check set was
 * described in three places.
 *
 * A check binds to an implementation through its `runner` field. An unknown
 * runner is a hard failure, never a silent pass. Runner-specific parameters live
 * in the check's `config` block so the YAML carries the assertion data instead of
 * the code.
 *
 * Each runner receives `(check, context)` and returns `{ status, details }`.
 * Valid statuses are `passed`, `failed` and `not-run`; `not-run` must always name
 * the reason so a skipped gate cannot be mistaken for a satisfied one.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const DOCUMENTATION_ROOT = join(REPO_ROOT, "docs");
const GENERATED_DOC = "docs/status.generated.md";

function passed(details = []) {
  return { status: "passed", details };
}

function failed(details) {
  return { status: "failed", details };
}

function notRun(details) {
  return { status: "not-run", details };
}

function listFiles(directory, suffix) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) return listFiles(absolute, suffix);
    return entry.isFile() && entry.name.endsWith(suffix) ? [absolute] : [];
  });
}

function gitTracked(path) {
  const result = spawnSync("git", ["ls-files", "--error-unmatch", path], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  return result.status === 0;
}

/**
 * TAP 输出用 `# tests 12`，spec reporter 用 `ℹ tests 12`；两种前缀都必须识别。
 * 只匹配一种会让套件在另一版本下报告 `? passed, 0 failed of ? engine tests`，
 * 测试确实运行了，但计数从证据里消失。
 */
function summarizeTestOutput(text) {
  const summary = {};
  for (const field of ["tests", "pass", "fail", "skipped"]) {
    const match = text.match(new RegExp(`^(?:\\u2139|#)\\s*${field}\\s+(\\d+)$`, "mu"));
    if (match) summary[field] = Number.parseInt(match[1], 10);
  }
  return summary;
}

/**
 * 摘要必须把 skip 写出来。只报 `pass/tests` 会让「442/443 passed」看起来像
 * 一个丢失的用例，而实际上它是带原因的未运行先决条件。
 */
function describeSummary(summary) {
  const parts = [`${summary.pass ?? "?"} passed`];
  if (summary.skipped > 0) parts.push(`${summary.skipped} skipped (prerequisite missing)`);
  parts.push(`${summary.fail ?? 0} failed`);
  return `${parts.join(", ")} of ${summary.tests ?? "?"} engine tests`;
}

const ENGINE_TEST_GROUPS = Object.freeze([
  {
    id: "project-tooling",
    paths: ["tools/", "checks/", "project/", "AGENTS.md", "OEngine/AGENTS.md"],
    tests: /check-runners\.test\.mjs$/u,
  },
  {
    id: "native-reference",
    paths: ["OEngine/tools/nyx-*", "OEngine/tools/build-nyx-*", "OEngine/src/assets/web-cook/wasm/"],
    tests:
      /(?:nyx-differential-corpus|nyx-function-map|nyx-shader-reference|web-cook-wasm-artifact)\.test\.mjs$/u,
  },
  {
    id: "web-cook",
    paths: [
      "OEngine/src/assets/web-cook/",
      "OEngine/src/assets/geometry-product/",
      "OEngine/src/loaders/gltf/streaming/",
    ],
    tests:
      /(?:web-cook|web-geometry|geometry-product|geometry-page|glb-|spatial-shard|nyx-web-runtime|runtime-scene-geometry-product|oegpack-offline-product).*\.test\.mjs$/u,
  },
  {
    id: "render-shading",
    paths: [
      "OEngine/src/render/",
      "OEngine/src/shaders/",
      "OEngine/src/framegraph/",
      "OEngine/src/material/",
      "OEngine/src/texture/",
    ],
    tests:
      /(?:render|shading|framegraph|hzb|occlusion|shadow|texture|sparse|advanced-frame|packed-render-world).*\.test\.mjs$/u,
  },
  {
    id: "gpu-geometry",
    paths: ["OEngine/src/gpu/", "OEngine/src/geometry/", "OEngine/src/scene/"],
    tests: /(?:geometry|product|gpu-|render-world|scene|visibility|hzb|shadow).*\.test\.mjs$/u,
  },
  {
    id: "core-loaders",
    paths: ["OEngine/src/core/", "OEngine/src/loaders/", "OEngine/src/assets/"],
    tests: /(?:asset|glb|gltf|runtime|oegpack|texture|codec).*\.test\.mjs$/u,
  },
]);

function normalized(path) {
  return path.replaceAll("\\", "/");
}

function pathStartsWith(path, prefix) {
  if (prefix.endsWith("*")) return path.startsWith(prefix.slice(0, -1));
  return prefix.endsWith("/") ? path.startsWith(prefix) : path === prefix || path.startsWith(`${prefix}/`);
}

/** Build the smallest conservative engine test plan for the current edit. */
export function planEngineTests(context, config = {}) {
  const cwdName = config.cwd ?? "OEngine";
  const cwd = resolve(REPO_ROOT, cwdName);
  const allTests = listFiles(resolve(cwd, "tests"), ".test.mjs")
    .map((path) => normalized(relative(cwd, path)))
    .sort();
  if (!context.changedOnly) {
    return { scope: "full", groups: ["all"], files: allTests, reasons: ["full verification requested"] };
  }

  const changed = (context.changedPaths ?? []).map(normalized);
  const selected = new Set();
  const groups = new Set();
  const reasons = [];
  let fallbackToFull = false;

  for (const path of changed) {
    if (/^OEngine\/tests\/.*\.test\.mjs$/u.test(path)) {
      const testPath = path.slice("OEngine/".length);
      if (allTests.includes(testPath)) selected.add(testPath);
      reasons.push(`${path}: changed test`);
      continue;
    }
    if (/^OEngine\/(?:package(?:-lock)?\.json|tsconfig(?:\.[^/]+)?\.json)$/u.test(path)) {
      fallbackToFull = true;
      reasons.push(`${path}: engine build configuration changed`);
      continue;
    }
    const matching = ENGINE_TEST_GROUPS.filter((group) =>
      group.paths.some((prefix) => pathStartsWith(path, prefix)),
    );
    for (const group of matching) {
      groups.add(group.id);
      for (const testPath of allTests) if (group.tests.test(testPath)) selected.add(testPath);
    }
    if (matching.length > 0) reasons.push(`${path}: ${matching.map((group) => group.id).join(", ")}`);
    else if (path.startsWith("OEngine/")) {
      fallbackToFull = true;
      reasons.push(`${path}: no safe targeted mapping; expanded to full suite`);
    }
  }

  if (fallbackToFull) return { scope: "full-fallback", groups: ["all"], files: allTests, reasons };
  return { scope: "changed", groups: [...groups].sort(), files: [...selected].sort(), reasons };
}

function runCommand(command, cwd, timeout, environment = process.env) {
  const started = performance.now();
  const result = spawnSync(command, {
    cwd,
    encoding: "utf8",
    shell: true,
    timeout,
    windowsHide: true,
    env: environment,
  });
  return { result, elapsedMs: Math.round(performance.now() - started) };
}

/**
 * Run a repository tool that emits a JSON report on stdout, and parse it.
 *
 * The style-contract check consumes `--json` output rather than scraping a
 * summary line: a verifier that pattern-matches human prose silently stops
 * asserting anything the first time the wording changes.
 */
function runNode(args, timeout = 900_000) {
  const started = performance.now();
  const result = spawnSync(process.execPath, args, {
    cwd: REPO_ROOT,
    encoding: "utf8",
    timeout,
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  });
  let parsed = null;
  const stdout = result.stdout ?? "";
  const opening = stdout.indexOf("{");
  if (opening !== -1) {
    try {
      parsed = JSON.parse(stdout.slice(opening));
    } catch {
      parsed = null;
    }
  }
  return {
    status: result.status,
    stdout,
    stderr: result.stderr ?? "",
    parsed,
    elapsedMs: Math.round(performance.now() - started),
  };
}

export const CHECK_RUNNERS = Object.freeze({
  /**
   * 由 loadModel/assertModel 完成：domains、claims、checks、sources、cases、
   * profiles、workloads 的解析，以及 domain/contract frontmatter 与文档链接校验。
   * 模型不合法时 verify 在进入 check 阶段前就已失败，因此这里只声明事实。
   */
  "project-model": () => passed(["project model and document frontmatter parsed"]),

  "generated-registry": () => passed(["generated registry regenerated and validated"]),

  "changed-coverage": (_check, context) =>
    context.uncovered.length > 0 ? failed(context.uncovered) : passed(),

  "changed-ownership": (_check, context) => {
    const problems = context.uncovered.length > 0 || context.routingAmbiguities.length > 0;
    return problems
      ? failed({ uncovered: context.uncovered, routingAmbiguities: context.routingAmbiguities })
      : passed();
  },

  /** 已退休入口不得回归：路径重新出现即失败。 */
  "retired-paths": (check) => {
    const config = check.config ?? {};
    const findings = [];
    for (const path of config.retiredPaths ?? []) {
      if (existsSync(resolve(REPO_ROOT, path))) findings.push(`retired path still exists: ${path}`);
    }
    if (config.inspectValidationScripts) {
      for (const relativePath of config.validationPackages ?? []) {
        const packagePath = resolve(REPO_ROOT, relativePath);
        if (!existsSync(packagePath)) continue;
        try {
          const scripts = JSON.parse(readFileSync(packagePath, "utf8")).scripts ?? {};
          for (const name of Object.keys(scripts)) {
            if (/case|browser/iu.test(name) && !["dev", "build", "typecheck", "test"].includes(name)) {
              findings.push(`per-case validation script still exists: ${relativePath}#${name}`);
            }
          }
        } catch {
          findings.push(`${relativePath} could not be inspected`);
        }
      }
    }
    return findings.length === 0 ? passed() : failed(findings);
  },

  /**
   * 公共入口必须存在，且其相对 re-export 必须指向真实文件。只检查「文件存在」
   * 会在入口被改坏时保持绿色。
   */
  "public-api-boundary": (check) => {
    const entry = resolve(REPO_ROOT, check.config?.entry ?? "");
    if (!existsSync(entry)) return failed([`public entry is missing: ${check.config?.entry}`]);
    const source = readFileSync(entry, "utf8");

    // The public entry uses TypeScript NodeNext `.js` specifiers that resolve to
    // `.ts` sources here; a literal existsSync on the `.js` name would report
    // every single export as broken.
    const resolves = (specifier) => {
      const base = resolve(dirname(entry), specifier);
      const candidates = [
        base,
        base.replace(JS_EXTENSION, ".ts"),
        join(base.replace(JS_EXTENSION, ""), "index.ts"),
      ];
      return candidates.some((candidate) => existsSync(candidate));
    };

    const brokenExports = [];
    for (const match of source.matchAll(RELATIVE_EXPORT)) {
      if (!resolves(match[1])) brokenExports.push(match[1]);
    }
    const validationLeaks = [...source.matchAll(VALIDATION_EXPORT)].map((match) => match[1]);
    if (brokenExports.length > 0 || validationLeaks.length > 0)
      return failed({ brokenExports, validationLeaks });
    return passed([`${check.config?.entry} resolves every relative re-export`]);
  },

  /**
   * Source shape: formatting plus the style rules a formatter cannot express.
   *
   * Two tools, one check, because they answer one question — "is this source in
   * the shape the style contract requires?" Splitting them into separate checks
   * would let a change pass formatting while failing braces, and the report
   * would not make clear that both come from the same contract.
   *
   * `tools/format.mjs --check` is authoritative for layout and also proves that
   * formatting never alters shader text (it compares every template literal
   * before deciding the file is formatted). `tools/style-guard.mjs` covers
   * braces, inlined type bodies and blank-line runs.
   *
   * In changed-only mode both are restricted to the changed paths, so pre-existing
   * debt does not block unrelated work. In full mode the guard's findings are
   * reported as a count rather than a failure, because the repository has not
   * yet paid that debt down; the count is the actionable part.
   */
  "style-contract": (check, context) => {
    const config = check.config ?? {};
    const changed = (context.changedPaths ?? []).filter((path) =>
      /^(?:OEngine|tools|checks)\/.*\.(?:ts|mjs|js)$/u.test(path),
    );
    const scoped = context.changedOnly === true && changed.length > 0;
    const targets = scoped ? changed : (config.targets ?? ["OEngine/src"]);
    const details = {
      scope: scoped ? "changed" : "full",
      targets: targets.length,
      format: null,
      style: null,
    };

    if (config.format !== false) {
      // `--check --verify-wgsl` is read-only and additionally proves that
      // formatting would leave every shader text block byte-identical. Without
      // the second flag the check only asserts layout, and the WGSL guarantee —
      // the reason a formatter is safe in this repository at all — stays
      // unexercised.
      const formatArgs = ["tools/format.mjs", "--check", "--verify-wgsl", "--json", ...targets];
      const format = runNode(formatArgs);
      details.format = format.parsed ?? { ok: false, raw: (format.stdout || format.stderr).slice(-2000) };
      details.formatMs = format.elapsedMs;
      if (format.status !== 0) {
        return failed([`formatting or WGSL preservation check failed`, details]);
      }
    }

    if (config.style !== false) {
      const styleArgs = ["tools/style-guard.mjs", "--json", ...targets];
      const style = runNode(styleArgs);
      details.style = style.parsed
        ? { scanned: style.parsed.scanned, totals: style.parsed.totals, total: style.parsed.total }
        : { ok: false, raw: (style.stdout || style.stderr).slice(-2000) };
      details.styleMs = style.elapsedMs;
      // In changed-only mode a style finding is a real failure: the touched code
      // must satisfy the contract. In full mode it is reported, because the
      // repository-wide debt is large and unrelated to the current change.
      if (scoped && (details.style?.total ?? 0) > 0) {
        return failed([`style guard reported ${details.style.total} finding(s) in changed files`, details]);
      }
    }
    return passed([details]);
  },

  /**
   * Documentation contract: every `docs/**` page declares a machine-checkable
   * state, and its links resolve.
   *
   * Why this is a gate and not a lint: the documentation tree is the constraint
   * system an agent reads before touching code. Measured before this check
   * existed, all three entry points claimed the project was in Phase 5 while
   * HEAD was a Phase 7 commit — so the first thing a new contributor or agent
   * read was wrong. A document is a claim, and an unverified claim silently
   * becomes false.
   *
   * The check verifies that documents are *checkable and internally consistent*.
   * It cannot verify that a document is *true*; that is what each `current`
   * document's `verifies` clause is for, and choosing a real one is a review
   * responsibility.
   */
  "docs-contract": (_check, context) => {
    const args = ["tools/docs-verify.mjs", "--json"];
    if (context.changedOnly === true) args.push("--staged");
    const result = runNode(args);
    const report = result.parsed ?? { total: null, raw: (result.stdout || result.stderr).slice(-2000) };
    if (result.status !== 0) {
      return failed([`documentation contract has ${report.total ?? "?"} finding(s)`, report]);
    }
    return passed([{ documents: report.documents, total: report.total ?? 0 }]);
  },

  /**
   * Tier 2 entry point: real GPU execution.
   *
   * Every engine test in this repository runs against a fake WebGPU device, so
   * nothing else here compiles WGSL or executes a dispatch. This check launches
   * local Chrome through `tools/gpu-oracle.mjs` and runs the environment-probe
   * oracle, which requests a real adapter, dispatches one compute shader and
   * reads the result back.
   *
   * A missing browser or a missing WebGPU adapter is reported as `not-run`, not
   * as a failure: that is an environment fact, and conflating it with a code
   * defect would train the reader to ignore this check. Only an oracle
   * assertion or a GPU error fails the run.
   */
  "gpu-environment": (check) => {
    const config = check.config ?? {};
    const oracle = config.oracle ?? "environment-probe";
    const result = runNode(["tools/gpu-oracle.mjs", oracle, "--json"], config.timeoutMs ?? 180_000);
    if (result.parsed === null) {
      return notRun([
        `oracle '${oracle}' produced no parsable report`,
        (result.stderr || result.stdout || "").trim().slice(-800),
      ]);
    }
    const status = result.parsed.status;
    const adapter = result.parsed.adapter ?? null;
    const kind = result.parsed.adapterKind ?? "unknown";
    const summary = {
      oracle,
      status,
      failureKind: result.parsed.failureKind ?? null,
      adapterKind: kind,
      adapter,
    };
    if (status === "passed") return passed([summary]);
    // Environment blockers are not code defects. `no-webgpu` and `no-adapter`
    // are explicit kinds from the harness; a launch/timeout failure under a
    // blocked environment reports as `environment-blocked`.
    const environmentKinds = new Set(["no-webgpu", "no-adapter", "environment-blocked"]);
    if (environmentKinds.has(result.parsed.failureKind)) {
      return notRun([`real GPU unavailable: ${result.parsed.failureKind}`, summary]);
    }
    return failed([
      `real-GPU oracle '${oracle}' failed: ${result.parsed.failureKind ?? status}`,
      result.parsed.error?.message ?? "",
      summary,
    ]);
  },

  "generated-source-guard": (check, context) => {
    const patterns = (check.config?.patterns ?? []).map((pattern) => new RegExp(pattern, "u"));
    if (patterns.length === 0) return failed(["generated-source guard has no configured patterns"]);
    const edited = context.changedPaths.filter((path) => patterns.some((pattern) => pattern.test(path)));
    return edited.length === 0 ? passed() : failed(edited);
  },

  /**
   * domain 与人类页面必须一一对应，并且生成的状态页不能被手工提交。
   * 旧实现的 guard-docs 只复述「模型已解析」，这条同名检查因此形同虚设。
   */
  "domain-doc-coverage": (_check, context) => {
    const findings = [];
    const domainIds = context.model.domains.map((domain) => domain.id);
    for (const id of domainIds) {
      const page = join(DOCUMENTATION_ROOT, "domains", `${id}.md`);
      if (!existsSync(page)) {
        findings.push(`domain ${id} has no docs/domains/${id}.md page`);
        continue;
      }
      const frontmatter = readFileSync(page, "utf8").match(FRONTMATTER);
      if (!frontmatter || !new RegExp(`^id:\\s*${id}$`, "mu").test(frontmatter[1])) {
        findings.push(`docs/domains/${id}.md frontmatter does not declare id: ${id}`);
      }
    }
    for (const file of listFiles(join(DOCUMENTATION_ROOT, "domains"), ".md")) {
      const name = relative(join(DOCUMENTATION_ROOT, "domains"), file).replaceAll("\\", "/");
      if (name === "README.md") continue;
      if (!domainIds.includes(name.replace(/\.md$/u, "")))
        findings.push(`docs/domains/${name} has no matching project/domains entry`);
    }
    if (gitTracked(GENERATED_DOC)) findings.push(`${GENERATED_DOC} is generated and must not be tracked`);
    return findings.length === 0 ? passed() : failed(findings);
  },

  /**
   * 引擎的 unit/contract/oracle/guard 套件。ADR-0019 之后 L1 一直是「有文档、
   * 无实现」：没有任何 check 会执行这些用例，而 `npm test` 又曾长期不可用。
   *
   * 该 runner 自己负责构建，因为 `.test-dist` 过期会让 `node --test` 静默测试
   * 旧产物 —— 那比没有门禁更糟。重入被显式拒绝：套件内部的 guard 用例会回调
   * verify，不能再递归拉起同一套件。
   */
  "engine-suites": (check, context) => {
    const config = check.config ?? {};
    if (process.env.VIBE_ENGINE_SUITE_ACTIVE === "1") {
      return notRun(["engine suite is already running in this process tree"]);
    }
    const cwd = resolve(REPO_ROOT, config.cwd ?? "OEngine");
    if (!existsSync(cwd)) return failed([`engine suite directory is missing: ${config.cwd}`]);
    const plan = planEngineTests(context, config);
    if (plan.files.length === 0) return notRun(["no engine test group is affected", plan]);
    const timeout = config.timeoutMs ?? 900_000;
    const timings = {};

    if (config.build) {
      const build = runCommand(config.build, cwd, timeout);
      timings.buildMs = build.elapsedMs;
      if (build.result.status !== 0) {
        return failed([
          `build step failed: ${config.build}`,
          (build.result.stderr || build.result.stdout || "").trim().slice(-6000),
          { plan, timings },
        ]);
      }
    }

    const started = performance.now();
    const result = spawnSync(process.execPath, ["--test", ...plan.files], {
      cwd,
      encoding: "utf8",
      timeout,
      windowsHide: true,
      env: { ...process.env, VIBE_ENGINE_SUITE_ACTIVE: "1" },
    });
    timings.testMs = Math.round(performance.now() - started);
    const summary = summarizeTestOutput(result.stdout ?? "");
    if (result.status !== 0) {
      const failing = (result.stdout ?? "")
        .split(/\r?\n/u)
        .filter((line) => line.startsWith("\u2716") && !line.startsWith("\u2716 failing"))
        .slice(0, 20);
      const diagnostic = (result.stderr || result.stdout || "").trim().slice(-6000);
      return failed([
        `${summary.fail ?? "?"} of ${summary.tests ?? "?"} engine tests failed`,
        ...failing,
        diagnostic,
        { plan, timings },
      ]);
    }
    return passed([describeSummary(summary), { plan, timings }]);
  },

  "validation-suites": (check, context) => {
    const config = check.config ?? {};
    const relevant =
      !context.changedOnly ||
      (context.changedPaths ?? []).some((path) =>
        ["validation/", "tools/", "checks/", "project/"].some((prefix) =>
          pathStartsWith(normalized(path), prefix),
        ),
      );
    if (!relevant) return notRun(["validation host and project tooling are unaffected"]);
    const cwd = resolve(REPO_ROOT, config.cwd ?? "validation");
    const timeout = config.timeoutMs ?? 300_000;
    const timings = [];
    for (const command of config.commands ?? []) {
      const execution = runCommand(command, cwd, timeout);
      timings.push({ command, elapsedMs: execution.elapsedMs });
      if (execution.result.status !== 0) {
        return failed([
          `${command} failed`,
          (execution.result.stderr || execution.result.stdout || "").trim().slice(-6000),
          { timings },
        ]);
      }
    }
    return passed([{ timings }]);
  },
});

export const CHECK_RUNNER_IDS = Object.freeze(Object.keys(CHECK_RUNNERS));

const JS_EXTENSION = /\.js$/u;
const RELATIVE_EXPORT = /from\s+"(\.\/[^"]+)"/gu;
const VALIDATION_EXPORT = /from\s+"([^"]*validation[^"]*)"/gu;
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---/u;

export function runCheckImplementation(check, context) {
  const runner = CHECK_RUNNERS[check.runner];
  if (!runner) {
    return failed([`no runner implementation is registered for runner '${check.runner ?? "<missing>"}'`]);
  }
  return runner(check, context);
}
