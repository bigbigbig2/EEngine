# Project skill sources

The initial four-skill set recommended for EEngine architecture work is
available under `.agents/skills/`. Existing `webgpu` is recorded separately in
`WEBGPU-SKILLS-SOURCE.md`; it is the licensed project version and was not
overwritten by `cazala/webgpu-skill`, whose repository had no license file at
inspection time.

| Project skill | Source | Pinned source | Local treatment | License |
| --- | --- | --- | --- | --- |
| `repo-architecture` | `objectivlabs/reposkillopt/skills/repo-architecture` | `45eaff0ce37175f6589fb90a667e5ead0ba4d1af` | EEngine entrypoint uses `project/`, `docs/domains/`, and `vibe`; original `SKILL.md` is preserved in `references/upstream-SKILL.md` | Apache-2.0, copied to `LICENSE` |
| `writing-technical-design` | `mazrean/agent-skills/skills/writing-technical-design` | `7af14d020210ae97aacefaf8f830b248ec131e62` | EEngine entrypoint uses existing document ownership; original `SKILL.md` and all four references are preserved | MIT, copied to `LICENSE` |
| `skill-creator` | Codex system bundle at `$CODEX_HOME/skills/.system/skill-creator` | Bundled local version at installation time; `SKILL.md` SHA-256 `cccd291077ec57c6f50ca6529f0f3fb93212da09473effb2fcec808e81b21288` | Copied unchanged into the project, including scripts, references, assets, and license | Apache-2.0, included as `license.txt` |

The adaptations change only skill instructions, not engine code. Repository
`AGENTS.md` and explicit user instructions take precedence over these skills.
