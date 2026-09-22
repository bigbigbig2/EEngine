# OEngine Documentation

The repository uses a contract-driven project OS. Machine manifests route work and derive validation; human pages explain the stable owner boundaries; evidence records what the current revision actually proved.

## Start Here

1. Run `node tools/vibe.mjs context <path>` before changing code. Add `--claims`, `--cases`, or `--all` only when the compact route is insufficient.
2. Read the matching page under [domains](./domains/), then the linked contract under [contracts](./contracts/).
3. Run `node tools/vibe.mjs verify --changed` after editing.
4. Use `node tools/vibe.mjs status [domain]` to inspect claim state and `node tools/vibe.mjs evidence` to refresh evidence. Empty or partial raw input cannot remove compact records without `--force-empty` or `--force-prune`; use `evidence --check` for a read-only comparison.

## Source Of Truth

| Concern | Authoritative source |
| --- | --- |
| Path and owner routing | `project/domains/*.yaml` |
| Durable completion claims | `project/claims/*.yaml` |
| Executable/static checks | `checks/checks.yaml` |
| Active workstream | `project/workstreams/active/*.yaml` |
| Human domain facts | `docs/domains/*.md` |
| Cross-owner contracts | `docs/contracts/*.md` |
| Long-term decisions | `docs/adr/` |
| Exact ABI and formats | `docs/specs/` |
| External sources and licenses | `docs/sources/index.yaml`, `docs/porting/` |
| Browser cases | `validation/cases/<id>/case.yaml` |
| Browser harness | `validation/harness/` |
| Current evidence | `validation/evidence/index.json`, generated `docs/status.generated.md`, and ignored `.local/validation/` raw artifacts |

Unpromoted research cannot establish a product fact, ABI, claim status, or completion. Git history stores retired implementation narratives.

Domain Markdown frontmatter contains identity only. Contract, claim, check, and case relationships come from the matching machine manifests and are shown by `context`; do not copy those lists into human pages. Ordinary fixes and internal refactors add no document by default. Add or update a contract/spec for a stable cross-owner protocol or ABI, and add an ADR only for a long-lived choice with meaningful alternatives.

## Active Workstreams

Workstream YAML is the authoritative current TODO. Its first screen names the current slice, next tasks, and open gates; completed work is a short milestone summary linked to stable contracts or evidence. Detailed implementation history stays in Git. Task state is one of `todo`, `active`, `done`, or `blocked`; a workstream cannot become `done` while it has unfinished tasks or open gates.

- [Nyx producer convergence](../project/workstreams/active/nyx-convergence.yaml)
- [Web authored-large Virtual Geometry](../project/workstreams/active/web-100m-virtual-geometry.yaml) — current `large.glb` acceptance plan with deferred 100M scale gate for [ADR-0018](./adr/0018-web-100m-virtual-geometry.md)

## Reviews

Reviews are dated, non-authoritative audits. They record observations and recommendations but do not establish product facts or completion:

- [2026-09-21 · Documentation and validation system review](./reviews/2026-09-21-documentation-validation-system-review.md)
- [2026-09-23 · Documentation system refactor design](./reviews/2026-09-23-documentation-system-refactor-design.md)
- [ADR-0018 research draft · Authored-large target and deferred 100M architecture](./reviews/ADR-0018_Web_100M_Virtual_Geometry_Architecture.md)

Phase records remain available in Git and under `docs/reviews/` for audit, but are no longer part of the current documentation entry path.
