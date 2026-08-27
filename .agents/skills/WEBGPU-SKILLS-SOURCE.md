# WebGPU skills source record

- Upstream repository: https://github.com/Impertio-Studio/WebGPU-Claude-Skill-Package
- Upstream commit: `2508ed0931284ed1cb671283568105264207578d`
- Upstream source paths: `skills/source/**/SKILL.md` and `skills/source/**/references/`
- License: MIT; preserved as `LICENSE-webgpu-claude-skill-package.txt`

## Preserved invariants

- Preserve all 35 upstream instruction bodies and all 105 reference files.
- Preserve legacy topic identifiers so cross-topic routing remains traceable.
- Preserve WebGPU/WGSL examples and technical guidance without framework dependencies.
- Keep repository `AGENTS.md` constraints authoritative for OEngine work.

## Codex adaptations

- Expose two repository skills: `$webgpu` for implementation and `$webgpu-review`
  for explicit audits and validation.
- Store the pipeline orchestrator and 33 detailed skill bodies as topic-level
  `guidance.md` files under `$webgpu/references/`.
- Keep the quality-validator body in `$webgpu-review` and map its legacy skill names
  to `$webgpu` topic identifiers.
- Flatten each topic's `methods.md`, `examples.md`, and `anti-patterns.md` beside its
  `guidance.md` so only the needed detail is loaded.
- Use Codex-compatible frontmatter and per-skill `agents/openai.yaml` metadata.