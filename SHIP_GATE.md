# Ship Gate

> No repo is "done" until every applicable line is checked.

**Tags:** `[all]` every repo · `[npm]` `[pypi]` `[vsix]` `[desktop]` `[container]` published artifacts · `[mcp]` MCP servers · `[cli]` CLI tools

**Last reviewed:** 2026-05-16 (Phase 3 Wave 3b — post-extraction refresh).

---

## A. Security Baseline

- [x] `[all]` SECURITY.md exists (report email, supported versions, response timeline)
- [x] `[all]` README includes threat model paragraph (data touched, data NOT touched, permissions required)
- [x] `[all]` No secrets, tokens, or credentials in source or diagnostics output
- [x] `[all]` No telemetry by default — state it explicitly even if obvious

### Default safety posture

- [ ] `[cli|mcp|desktop]` SKIP: synthesis engine with WebSocket server, no destructive operations
- [x] `[cli|mcp|desktop]` File operations constrained to known directories — WAV output to user-specified paths
- [ ] `[mcp]` SKIP: not an MCP server
- [ ] `[mcp]` SKIP: not an MCP server

## B. Error Handling

- [x] `[all]` Errors follow the Structured Error Shape: `code`, `message`, `hint`, `cause?`, `retryable?` — TypeScript error classes
- [ ] `[cli]` SKIP: library/server, not standalone CLI
- [ ] `[cli]` SKIP: library/server, not standalone CLI
- [ ] `[mcp]` SKIP: not an MCP server
- [ ] `[mcp]` SKIP: not an MCP server
- [ ] `[desktop]` SKIP: not a desktop app
- [ ] `[vscode]` SKIP: not a VS Code extension

## C. Operator Docs

- [x] `[all]` README is current: what it does, install, usage, supported platforms + runtime versions
- [x] `[all]` CHANGELOG.md (Keep a Changelog format)
- [x] `[all]` LICENSE file present and repo states support status
- [ ] `[cli]` SKIP: not a standalone CLI
- [ ] `[cli|mcp|desktop]` SKIP: engine library with no configurable logging levels
- [ ] `[mcp]` SKIP: not an MCP server
- [ ] `[complex]` SKIP: comprehensive test suite serves as documentation

## D. Shipping Hygiene

- [x] `[all]` `verify` script exists (test + build + smoke in one command) — `npm run verify` (also `scripts/verify.sh`)
- [ ] `[all]` Version in manifest matches git tag — no `v1.0.3` tag exists in local clone yet (post-extraction). Tag against release commit before publish.
- [x] `[all]` Dependency scanning runs in CI (ecosystem-appropriate) — `npm audit --audit-level=high` on push + PR + weekly schedule
- [x] `[all]` Automated dependency update mechanism exists — Dependabot npm + GitHub Actions + Docker (monthly grouped)
- [x] `[npm]` `npm pack --dry-run` includes: dist/, README.md, LICENSE — files[] declared, 264.8 kB tarball post-wave-3a
- [x] `[npm]` `engines.node` set — `>=20`
- [x] `[npm]` Lockfile committed
- [ ] `[pypi]` SKIP: not a Python project
- [ ] `[vsix]` SKIP: not a VS Code extension
- [ ] `[desktop]` SKIP: not a desktop app

## E. Identity (soft gate — does not block ship)

- [x] `[all]` Logo in README header
- [x] `[all]` Translations (polyglot-mcp, 8 languages)
- [x] `[org]` Landing page (@mcptoolshop/site-theme)
- [x] `[all]` GitHub repo metadata: description, homepage, topics

## Notes

- **Lint:** Intentionally NOT enforced. `ci.yml` calls `npm run lint --if-present`; no `lint` script is defined, so the step no-ops by design. If linting becomes desired, install ESLint + Prettier and the `--if-present` guard will auto-engage.
- **Dogfood scenario:** `dogfood.yml` requires repo secret `DOGFOOD_TOKEN` for cross-repo dispatch to `mcp-tool-shop-org/dogfood-labs`. If unset, the dispatch step emits a benign warning.
