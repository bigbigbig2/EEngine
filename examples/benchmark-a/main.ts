import { startBenchmarkPage } from "../benchmark-shared/BenchmarkPage.ts";

void startBenchmarkPage(
  new URL("../benchmark-shared/manifests/benchmark-a.json", import.meta.url)
);
