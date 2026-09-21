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
  const result = spawnSync("git", ["ls-files", "--error-unmatch", path], { cwd: REPO_ROOT, encoding: "utf8" });
  return result.status === 0;
}

/** Extract the node:test summary lines so a failure detail is actionable. */
function summarizeTestOutput(text) {
  const summary = {};
  for (const field of ["tests", "pass", "fail", "skipped"]) {
    const match = text.match(new RegExp(`^\\u2139 ${field} (\\d+)$`, "mu"));
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

export const CHECK_RUNNERS = Object.freeze({
  /**
   * 由 loadModel/assertModel 完成：domains、claims、checks、sources、cases、
   * profiles、workloads 的解析，以及 domain/contract frontmatter 与文档链接校验。
   * 模型不合法时 verify 在进入 check 阶段前就已失败，因此这里只声明事实。
   */
  "project-model": () => passed(["project model and document frontmatter parsed"]),

  "generated-registry": () => passed(["generated registry regenerated and validated"]),

  "changed-coverage": (_check, context) => context.uncovered.length > 0
    ? failed(context.uncovered)
    : passed(),

  "changed-ownership": (_check, context) => {
    const problems = context.uncovered.length > 0 || context.routingAmbiguities.length > 0;
    return problems
      ? failed({ uncovered: context.uncovered, routingAmbiguities: context.routingAmbiguities })
      : passed();
  },

  "evidence-provenance": (_check, context) => {
    if (context.evidence.errors?.length > 0) return failed(context.evidence.errors);
    if ((context.evidence.evidence ?? []).length === 0) return passed(["evidence index is valid and currently empty"]);
    return passed([`${context.evidence.evidence.length} compact evidence record(s) are structurally valid`]);
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
      const candidates = [base, base.replace(JS_EXTENSION, ".ts"), join(base.replace(JS_EXTENSION, ""), "index.ts")];
      return candidates.some((candidate) => existsSync(candidate));
    };

    const brokenExports = [];
    for (const match of source.matchAll(RELATIVE_EXPORT)) {
      if (!resolves(match[1])) brokenExports.push(match[1]);
    }
    const validationLeaks = [...source.matchAll(VALIDATION_EXPORT)].map((match) => match[1]);
    if (brokenExports.length > 0 || validationLeaks.length > 0) return failed({ brokenExports, validationLeaks });
    return passed([`${check.config?.entry} resolves every relative re-export`]);
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
      if (!domainIds.includes(name.replace(/\.md$/u, ""))) findings.push(`docs/domains/${name} has no matching project/domains entry`);
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
    if (context.changedOnly && !context.changedPaths.some((path) => path.startsWith(`${config.cwd ?? "OEngine"}/`))) {
      return notRun([`no ${config.cwd ?? "OEngine"} path changed`]);
    }
    const timeout = config.timeoutMs ?? 900_000;

    if (config.build) {
      const build = spawnSync(config.build, { cwd, encoding: "utf8", shell: true, timeout, windowsHide: true });
      if (build.status !== 0) {
        return failed([`build step failed: ${config.build}`, (build.stderr || build.stdout || "").trim().slice(-2000)]);
      }
    }

    const result = spawnSync(process.execPath, ["--test", config.testFiles], {
      cwd,
      encoding: "utf8",
      timeout,
      windowsHide: true,
      env: { ...process.env, VIBE_ENGINE_SUITE_ACTIVE: "1" }
    });
    const summary = summarizeTestOutput(result.stdout ?? "");
    if (result.status !== 0) {
      const failing = (result.stdout ?? "")
        .split(/\r?\n/u)
        .filter((line) => line.startsWith("\u2716") && !line.startsWith("\u2716 failing"))
        .slice(0, 20);
      return failed([`${summary.fail ?? "?"} of ${summary.tests ?? "?"} engine tests failed`, ...failing]);
    }
    return passed([describeSummary(summary)]);
  }
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
