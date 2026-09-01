import React from "react";
import type { ReactNode } from "react";
import type { ExampleCatalogEntry } from "../catalog";

function exampleRunnerUrl(route: string): string {
  const documentRoute = appendIndexDocument(route);
  const explicitBase = import.meta.env.VITE_OENGINE_EXAMPLES_ORIGIN;
  if (explicitBase !== undefined && explicitBase.length > 0) {
    return new URL(documentRoute, `${explicitBase.replace(/\/$/, "")}/`).href;
  }
  const storybookBase = new URL(import.meta.env.BASE_URL, window.location.origin);
  return new URL(`runtime/${documentRoute}`, storybookBase).href;
}

function appendIndexDocument(route: string): string {
  const suffixIndex = route.search(/[?#]/u);
  const path = suffixIndex < 0 ? route : route.slice(0, suffixIndex);
  const suffix = suffixIndex < 0 ? "" : route.slice(suffixIndex);
  return path.endsWith("/") ? `${path}index.html${suffix}` : route;
}

export function CatalogExample({ entry }: { readonly entry: ExampleCatalogEntry }): ReactNode {
  const runtimeUrl = exampleRunnerUrl(entry.route);
  return (
    <div className="oe-fullscreen-example">
      <iframe
        className="oe-runtime-frame"
        src={runtimeUrl}
        title={`${entry.title} runtime`}
        loading="eager"
        sandbox="allow-scripts allow-same-origin allow-downloads"
        allow="fullscreen"
      />
    </div>
  );
}
