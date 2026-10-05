# Guards

Guards are lightweight topology and ownership checks. They explain why a change is rejected; they do not replace unit, contract, oracle, GPU, or performance evidence.

Each guard declares _what_ it asserts; `tools/check-runners.mjs` owns _how_ the assertion runs. A guard binds to an implementation through its `runner` field and carries its own parameters under `config`, so adding a guard does not mean editing the CLI. A guard whose `runner` is not registered fails the model check rather than passing silently, and `OEngine/tests/guard/check-runners.test.mjs` pins the pass/fail behaviour of every runner.

- `docs` (`domain-doc-coverage`): one human page per project domain, filename matching the declared `id`, no orphan pages, and the generated status page is never tracked.
- `public-api` (`public-api-boundary`): the public entry exists, every relative re-export resolves to a real source file, and no validation internal leaks into it.
- `ownership` (`changed-ownership`): every existing changed path has one non-ambiguous primary domain owner.
- `legacy` (`retired-paths`): retired entry points and per-case validation scripts do not come back.
- `generated-source` (`generated-source-guard`): generated outputs are not edited as design authority.

Note that `docs/frontmatter`, link resolution, domain identity, and the existence of declared `currentDocs` pages are enforced during project-model parsing, before any guard runs. The `docs` guard only adds what the model cannot see: filename-to-`id` correspondence, orphan pages, and generated-document ownership.
