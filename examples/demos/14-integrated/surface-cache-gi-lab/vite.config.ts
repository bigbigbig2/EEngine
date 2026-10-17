import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import sharedConfig from "../../../vite.config";

export default defineConfig({
  ...sharedConfig,
  // Procedural-only entry: do not mount or copy the other demos' model assets.
  plugins: [],
  publicDir: false,
  build: {
    ...sharedConfig.build,
    emptyOutDir: false,
    rollupOptions: {
      input: fileURLToPath(new URL("./index.html", import.meta.url))
    }
  }
});
