---
name: repo-architecture
description: Map EEngine's current code ownership, runtime data flow, coupling, and change impact from cited source evidence before proposing architectural changes.
---

# Repository architecture analysis for EEngine

This is an EEngine adaptation of RepoSkillOpt's `repo-architecture`. The
[original instructions](references/upstream-SKILL.md) remain available for its
evidence-labeling and impact-analysis method. Its `.reposkillopt` repository
specification and artifact layout are not prerequisites here: EEngine already
has its own routing and current-fact system.

1. Start with the relevant `project/domains/*.yaml` owner routes,
   `docs/domains/*.md` current facts, and `node tools/vibe.mjs context <path>`.
   Expand with `--claims`, `--cases`, or `--all` only when needed.
2. Trace the requested behavior through actual entrypoints, creation,
   ownership, FrameGraph registration, GPU resources, WGSL, and consumers.
   Follow scene publication and device recovery when they affect the question.
3. Distinguish verified facts with `path:line` or symbol citations from
   inference and unknowns. Report unresolved dynamic edges explicitly.
4. For a proposed change, map affected owners, call sites, contracts, ABIs,
   shaders, and focused checks. State confidence from direct evidence, not
   filenames or class names alone.
5. Return the architecture view or impact map at the scale the user requested.
   Write a review document only when requested or when the task explicitly
   needs a lasting decision record. Do not generate `.reposkillopt/` artifacts.

`AGENTS.md`, current code, manifests, contracts, and source ledgers determine
EEngine's actual authority. An accepted ADR describes a target, not proof of
current implementation. This skill analyzes the as-is system; it does not
approve a future design or require old API compatibility.
