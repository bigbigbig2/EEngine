// Node TestsStream events, not the version-dependent human spec output.
export function summarizeTests(output, exitCode) {
  try {
    const events = output
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const summary = events.findLast((event) => event.type === "summary");
    const counts = summary?.counts;
    if (
      !summary?.complete ||
      !counts ||
      ["tests", "passed", "failed", "cancelled", "skipped", "todo"].some(
        (key) => !Number.isInteger(counts[key]) || counts[key] < 0,
      )
    )
      return { status: "failed", complete: false };
    const status =
      exitCode !== 0 || counts.failed || counts.cancelled
        ? "failed"
        : !counts.tests || !counts.passed || counts.skipped || counts.todo
          ? "not-run"
          : "passed";
    return { status, complete: true, counts, notRun: events.filter((event) => event.type === "not-run") };
  } catch {
    return { status: "failed", complete: false };
  }
}
export default async function* report(events) {
  for await (const { type, data } of events) {
    if (type === "test:summary" && !data.file)
      yield JSON.stringify({ type: "summary", complete: true, ...data }) + "\n";
    else if (type === "test:fail")
      yield JSON.stringify({ type: "failure", name: data.name, error: data.details?.error?.message }) + "\n";
    else if (type === "test:pass" && (data.skip || data.todo))
      yield JSON.stringify({ type: "not-run", name: data.name, reason: data.skip || data.todo }) + "\n";
    else if (type === "test:stdout" || type === "test:stderr")
      yield JSON.stringify({ type, message: data.message }) + "\n";
  }
}
