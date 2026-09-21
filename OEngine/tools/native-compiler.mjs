import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * 解析并校验原生构建使用的 C++ 编译器。
 *
 * 工具链位置因机器而异，因此按候选顺序探测，而不是在 win32 上钉死一个绝对
 * 路径：钉死会让「本机没装 MinGW」表现为长期红灯，而不是可解释的环境缺失。
 * CXX 环境变量始终优先。
 */
const CANDIDATES = process.platform === "win32"
  ? ["D:/Devtool/mingw64/bin/g++.exe", "C:/Program Files/LLVM/bin/clang++.exe", "g++"]
  : ["g++", "clang++"];

export function resolveNativeCompiler() {
  if (process.env.CXX) return process.env.CXX;
  for (const candidate of CANDIDATES) {
    if (candidate.includes("/") && !existsSync(candidate)) continue;
    return candidate;
  }
  return CANDIDATES[CANDIDATES.length - 1];
}

let probeCache;

/**
 * 「编译器存在」不等于「编译器可用」。
 *
 * Windows 上的 clang++ 在没有 MSVC/Windows SDK 头时能正常启动，但任何
 * `#include <vector>` 都会失败。只按路径存在性判定先决条件，会让原生验证层
 * 在事实上无法构建的机器上长期带红，并因此训练出忽略红灯的习惯。先决条件
 * 必须按实际编译能力判定，缺失时由调用方显式 skip 并说明原因。
 */
export function compilerProbe() {
  if (probeCache !== undefined) return probeCache;
  const compiler = resolveNativeCompiler();
  if (!compiler) {
    probeCache = { usable: false, compiler: null, reason: "没有可用的 C++ 编译器（设置 CXX，或安装 g++/clang++）" };
    return probeCache;
  }
  const directory = mkdtempSync(join(tmpdir(), "oengine-cxx-probe-"));
  try {
    const source = join(directory, "probe.cpp");
    writeFileSync(source, "#include <vector>\n#include <cstdio>\nint main() { std::vector<int> v{1}; std::printf(\"%d\", v[0]); return 0; }\n");
    const output = join(directory, process.platform === "win32" ? "probe.exe" : "probe");
    // clang 的 MSVC/Windows SDK 自动探测在这台机器上是间歇性的（同一命令可能
    // 一次性找不到 <vector>），所以失败后重试一次，避免把环境抖动误报成
    // 「先决条件缺失」而静默跳过原生 oracle。
    let result;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      result = spawnSync(compiler, [source, "-o", output], { encoding: "utf8", timeout: 60_000, windowsHide: true });
      if (result.status === 0) break;
    }
    const firstError = (result.stderr || result.stdout || "").split(/\r?\n/u).find((line) => line.includes("error")) ?? "";
    probeCache = result.status === 0
      ? { usable: true, compiler, reason: null }
      : { usable: false, compiler, reason: `${compiler} 无法编译包含标准库的翻译单元（缺少 MSVC/Windows SDK 头？）：${firstError.trim()}` };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
  return probeCache;
}

/** 供原生 oracle 用例导入的 skip 判定。 */
export function nativeCompilerSkipReason() {
  const probe = compilerProbe();
  return probe.usable ? false : probe.reason;
}
