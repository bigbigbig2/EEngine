import { registerHooks } from "node:module";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Engine TypeScript intentionally imports its emitted .js names. Node's native
// TS test runner needs this local resolution hook; production imports stay intact.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.endsWith(".js") && specifier.startsWith(".") && context.parentURL?.startsWith("file:")) {
      const emitted = new URL(specifier, context.parentURL);
      const source = new URL(specifier.slice(0, -3) + ".ts", context.parentURL);
      if (!existsSync(fileURLToPath(emitted)) && existsSync(fileURLToPath(source))) {
        return nextResolve(source.href, context);
      }
    }
    return nextResolve(specifier, context);
  },
});
