import path from "node:path";
import { createServer } from "vite";

export async function startValidationServer(examplesRoot) {
  const configuredBaseUrl = process.env.OENGINE_VALIDATION_BASE_URL;
  if (configuredBaseUrl) {
    return Object.freeze({
      baseUrl: configuredBaseUrl.replace(/\/$/, ""),
      owned: false,
      close: async () => {}
    });
  }

  const server = await createServer({
    configFile: path.join(examplesRoot, "vite.config.ts"),
    root: examplesRoot,
    server: { host: "127.0.0.1", port: 0, strictPort: false }
  });
  await server.listen();
  const baseUrl = server.resolvedUrls?.local[0]?.replace(/\/$/, "");
  if (baseUrl === undefined) {
    await server.close();
    throw new Error("Vite did not publish a local validation URL");
  }
  return Object.freeze({
    baseUrl,
    owned: true,
    close: () => server.close()
  });
}

