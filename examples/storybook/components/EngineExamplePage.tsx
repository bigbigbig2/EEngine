import React from "react";
import type { ReactNode } from "react";
import type { ExampleCatalogEntry, ExamplePageStatus } from "../catalog";

interface EngineExamplePageProps {
  readonly eyebrow: string;
  readonly title: string;
  readonly description: string;
  readonly status: ExamplePageStatus;
  readonly tags: readonly string[];
  readonly stats?: readonly (readonly [string, string])[];
  readonly sourcePath?: string;
  readonly launchRoute?: string;
  readonly children: ReactNode;
  readonly footer?: ReactNode;
}

function exampleRunnerUrl(route: string): string {
  const explicitBase = import.meta.env.VITE_OENGINE_EXAMPLES_ORIGIN;
  if (explicitBase !== undefined && explicitBase.length > 0) {
    return new URL(route, `${explicitBase.replace(/\/$/, "")}/`).href;
  }
  const storybookBase = new URL(import.meta.env.BASE_URL, window.location.origin);
  return new URL(`runtime/${route}`, storybookBase).href;
}

export function EngineExamplePage({
  eyebrow,
  title,
  description,
  status,
  tags,
  stats = [],
  sourcePath,
  launchRoute,
  children,
  footer
}: EngineExamplePageProps): ReactNode {
  return (
    <article className="oe-example-page">
      <header className="oe-example-header">
        <div className="oe-example-heading">
          <div>
            <p className="oe-example-eyebrow">{eyebrow}</p>
            <h1>{title}</h1>
          </div>
          <div className="oe-example-tags" aria-label="Example metadata">
            <span className={`oe-status oe-status-${status.toLowerCase().replaceAll(" ", "-")}`}>
              {status}
            </span>
            {tags.map((tag) => <span className="oe-tag" key={tag}>{tag}</span>)}
          </div>
        </div>
        <p className="oe-example-description">{description}</p>
      </header>

      <section className="oe-example-stage" aria-label={`${title} preview`}>
        {children}
        {stats.length > 0 && (
          <aside className="oe-live-stats" aria-label="Example statistics">
            <span className="oe-live-stats-title">Example contract</span>
            {stats.map(([label, value]) => (
              <span className="oe-live-stat" key={label}>
                <span>{label}</span><strong>{value}</strong>
              </span>
            ))}
          </aside>
        )}
      </section>

      {(footer !== undefined || sourcePath !== undefined || launchRoute !== undefined) && (
        <footer className="oe-example-footer">
          <div>{footer}</div>
          <div className="oe-example-actions">
            {sourcePath !== undefined && <code>{sourcePath}</code>}
            {launchRoute !== undefined && (
              <a href={exampleRunnerUrl(launchRoute)} target="_blank" rel="noreferrer">
                打开运行示例 <span aria-hidden="true">↗</span>
              </a>
            )}
          </div>
        </footer>
      )}
    </article>
  );
}

export function CatalogExample({ entry }: { readonly entry: ExampleCatalogEntry }): ReactNode {
  const runtimeUrl = exampleRunnerUrl(entry.route);
  return (
    <EngineExamplePage
      eyebrow={entry.id}
      title={entry.title}
      description={entry.description}
      status={entry.status}
      tags={entry.tags}
      stats={entry.stats}
      sourcePath={entry.sourcePath}
      launchRoute={entry.route}
      footer={<span>运行入口由 Storybook 同源托管，也可通过环境变量切换到独立 examples 服务。</span>}
    >
      <CatalogScene variant={entry.scene} />
      <iframe
        className="oe-runtime-frame"
        src={runtimeUrl}
        title={`${entry.title} runtime`}
        loading="eager"
        sandbox="allow-scripts allow-same-origin allow-downloads"
        allow="fullscreen"
      />
    </EngineExamplePage>
  );
}

function CatalogScene({ variant }: { readonly variant: ExampleCatalogEntry["scene"] }): ReactNode {
  return (
    <div className={`oe-catalog-scene oe-catalog-scene-${variant}`}>
      <div className="oe-catalog-sky" />
      <div className="oe-catalog-horizon" />
      <div className="oe-catalog-ground" />
      <div className="oe-catalog-grid" />
      <div className="oe-building oe-building-1" />
      <div className="oe-building oe-building-2" />
      <div className="oe-building oe-building-3" />
      <div className="oe-building oe-building-4" />
      <div className="oe-building oe-building-5" />
      <div className="oe-focus-object" />
    </div>
  );
}
