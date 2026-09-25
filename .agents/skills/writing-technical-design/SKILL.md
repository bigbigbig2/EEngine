---
name: writing-technical-design
description: Write evidence-backed EEngine renderer designs and ADRs with explicit ownership, GPU data flow, WebGPU constraints, source provenance, and implementation decisions.
---

# Technical design for EEngine

This project adaptation retains the upstream
[writing-technical-design instructions](references/upstream-SKILL.md) and its
[research method](references/DEEP-RESEARCH.md). Use them for source evaluation
and decision quality, while following EEngine's established document system.

1. Read the requested source path and its `node tools/vibe.mjs context <path>`
   route. Inspect code and `docs/domains/` for current behavior; use
   `docs/adr/`, active workstreams, and `docs/sources/` for decisions and
   external provenance. Keep target architecture separate from current facts.
2. Frame the concrete problem, workload, desired behavior, and non-goals.
   Show owner boundaries and the data path from producer to GPU consumer.
3. Compare viable designs against GPU work, bandwidth, memory, quality,
   WebGPU capabilities, lifecycle, and source portability. State assumptions
   and unresolved risks. Pin versions and licenses when selecting upstream
   implementations; do not label a candidate survey as a completed port.
4. Describe the chosen design, discarded alternatives, deletion/cutover
   boundary, and the smallest meaningful validation evidence. Match the
   detail to the decision; avoid speculative class and buffer layouts.
5. Place a lasting decision in `docs/adr/`, current implementation facts in
   `docs/domains/`, precise ABI/state contracts in `docs/contracts/` or
   `docs/specs/`, and upstream records in `docs/sources/`. Add documents only
   when the user's task needs them; ordinary refactors do not require one.

The upstream workflow proposes creating a new component Skill for every
researched technology. In EEngine, create or change component Skills only
when explicitly requested or when a recurring implementation workflow has
proved it needs one. Use `$skill-creator` for that separate task. Do not create
`specs/design-*`, `skills/tech-*`, or `.claude/rules/` by default.
