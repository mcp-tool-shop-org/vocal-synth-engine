# Contributing to vocal-synth-engine

Short version: run the tests, run `bash scripts/verify.sh`, open a PR.

## Development setup

```bash
npm ci
npm run build:server
npm test
```

For the cockpit UI:

```bash
npm run dev:cockpit   # Vite dev server, hot reload
```

For the server in watch mode:

```bash
npm run dev:server    # tsx watch
```

## Verification gate

Before opening a PR or pushing a release tag, run:

```bash
bash scripts/verify.sh
```

This runs the test suite, builds the server, and inspects the npm tarball (`npm pack --dry-run`). It is what CI also runs.

## Branch naming

- `feat/<short-name>` — new capability
- `fix/<short-name>` — bug fix
- `chore/<short-name>` — tooling, docs, deps
- `docs/<short-name>` — docs-only

## Commit messages

Conventional-commit prefixes. Examples already in `git log`:

- `feat: add polyphony sunset path`
- `fix(ci): make Dogfood dispatch tolerant of missing receiver`
- `chore(deps): bump express to 5.2.1`
- `docs: clarify /api/health response shape`

## Translations

`README.md` is the source of truth. The seven translated files (`README.{es,fr,hi,it,ja,pt-BR,zh}.md`) are regenerated locally via TranslateGemma 12B:

```bash
node E:/AI/polyglot-mcp/scripts/translate-all.mjs README.md
```

This runs locally — never inside Claude. If you change `README.md`, regenerate translations before pushing.

## Releases

Releases land on a `v*` tag. The release-spine workflow (Phase 10) will:

1. Verify gate (tests + build + pack)
2. Tag-vs-`package.json` version equality check
3. `npm publish --provenance`
4. Extract CHANGELOG section for the GitHub release body

Don't publish manually — let the workflow do it so the provenance attestation is generated against a clean GitHub-hosted runner.

## Reporting issues

Use the issue templates in `.github/ISSUE_TEMPLATE/`. For security, see `SECURITY.md`.

## Code of conduct

See `CODE_OF_CONDUCT.md`. Be kind, write specific feedback, assume good intent.
