# SupportX Enterprise (`packages/ee/`)

This directory is reserved for SupportX Enterprise features under the
[SupportX Commercial License](LICENSE). It is empty for now: every feature
that exists today is part of the AGPL core and stays there.

Rules for this directory:

- **One-way imports.** Code in `packages/ee/` may import from the core
  (`packages/core`, `packages/services`, …). Code outside `packages/ee/`
  never imports from it, so the AGPL edition builds and runs without this
  directory. `tests/unit/ee-boundary.test.ts` checks this.
- **New features only.** Code that was already published under AGPL or MIT
  stays available under those licenses. Moving it here does not take those
  rights back, so existing features are not moved.
- **Only TradeX code.** Contributions to this directory need a written
  agreement with TradeX International AG.

Candidates (proposal, not decided): see
[docs/LIZENZMODELL.de.md](../../docs/LIZENZMODELL.de.md).
