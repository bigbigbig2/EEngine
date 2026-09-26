# OEngine Documentation

The repository uses a contract-driven project OS. Machine manifests route work and derive validation; human pages explain the stable owner boundaries; evidence records what the current revision actually proved.

## Start Here

For the accepted EEngine Next clean-cut target, start with [单路径重建路线](./next-renderer.md). The current human-readable drafts are [整体架构设计](./next-design/renderer-architecture.md) and [详细执行文档](./next-execution/renderer-plan.md). They expand [ADR-0020](./adr/0020-clean-cut-renderer.md), [pinned migration sources](./porting/next-renderer.md), and the [current workstream](../project/workstreams/active/eengine-next-clean-rebuild.yaml). Target design is distinct from current runtime facts and completion evidence.

1. Run `node tools/vibe.mjs context <path>` before changing code. The compact route includes the primary owner, decisions, source IDs, relevant workstream slice/modules, contracts, and suggested checks. Add `--claims`, `--cases`, or `--all` only when more detail is needed.
2. Read the matching page under [domains](./domains/), then the linked contract under [contracts](./contracts/).
3. During the destructive rebuild, use `node tools/vibe.mjs context <path>` for navigation. At a large module's completion, run typecheck, build, and necessary targeted tests; `verify --changed` is optional. Reserve `verify --full` and browser acceptance for final Next Renderer integration.
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

## Current Workstreams

Workstream YAML is the authoritative current TODO, including paused work. During the Next rebuild, the active workstream stays compact: current module, goal, next modules, architecture rules, and deferred validation. Detailed design and execution reasoning live in the human documents; implementation history stays in Git. Missing browser runs, evidence, claims, or future phases do not block ongoing module coding.

- [Nyx producer convergence](../project/workstreams/active/nyx-convergence.yaml)
- [EEngine Next renderer](../project/workstreams/active/eengine-next-clean-rebuild.yaml) — Phase 3 production integration is recorded done; VSM is the next module. The [architecture draft](./next-design/renderer-architecture.md) and [execution draft](./next-execution/renderer-plan.md) describe the proposed refinement; the [implementation route](./next-renderer.md) retains the existing phase overview.
- [Web authored-large Virtual Geometry](../project/workstreams/active/web-100m-virtual-geometry.yaml) — paused K4 legacy Sparse Shading publication optimization; accepted K0–K3 evidence remains historical, and `large.glb` will be rebaselined on the new Surface/Shading Runtime

## Reviews

Reviews are dated, non-authoritative audits. They record observations and recommendations but do not establish product facts or completion:

- [2026-09-21 · Documentation and validation system review](./reviews/2026-09-21-documentation-validation-system-review.md)
- [2026-09-23 · Documentation system refactor design](./reviews/2026-09-23-documentation-system-refactor-design.md)
- [ADR-0018 historical research draft](./reviews/ADR-0018_Web_100M_Virtual_Geometry_Architecture.md)
- [EEngine Next clean-cut design discussion](./reviews/EEngine_Next_Renderer_Final_Architecture.md) — user-supplied design input for [ADR-0020](./adr/0020-clean-cut-renderer.md); earlier [review](./reviews/2026-09-25-eengine-next-final-architecture-analysis.md) and [discussion archive](./reviews/2026-09-25-eengine-next-final-architecture-source.md) remain historical

Phase records remain available in Git and under `docs/reviews/` for audit, but are no longer part of the current documentation entry path.

## Performance Diagnostics

Interactive investigations and their limitations are indexed under [performance](./performance/). These reports guide follow-up work; formal performance claims require the validation evidence described above.
