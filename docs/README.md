# OEngine Documentation

The repository uses a contract-driven project OS. Machine manifests route work and derive validation; human pages explain the stable owner boundaries; evidence records what the current revision actually proved.

## Start Here

1. Run `node tools/vibe.mjs context <path>` before changing code.
2. Read the matching page under [domains](./domains/), then the linked contract under [contracts](./contracts/).
3. Run `node tools/vibe.mjs verify --changed` after editing.
4. Use `node tools/vibe.mjs status [domain]` to inspect claim state and `node tools/vibe.mjs evidence` to refresh evidence.

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
