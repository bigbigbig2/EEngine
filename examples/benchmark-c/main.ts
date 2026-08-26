import { startBenchmarkPage } from "../benchmark-shared/BenchmarkPage.ts";

void startBenchmarkPage(
  new URL("../benchmark-shared/manifests/benchmark-c.json", import.meta.url)
);
