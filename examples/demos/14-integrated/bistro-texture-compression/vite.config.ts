import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import sharedConfig from "../../../vite.config";

export default defineConfig({
  ...sharedConfig,
  build: {
    ...sharedConfig.build,
    emptyOutDir: false,
    rollupOptions: {
      input: fileURLToPath(new URL("./index.html", import.meta.url))
    }
  }
});
