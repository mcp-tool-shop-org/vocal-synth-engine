# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| 1.0.x   | Yes       |

## Reporting a Vulnerability

Email: **64996768+mcp-tool-shop@users.noreply.github.com**

Include:
- Description of the vulnerability
- Steps to reproduce
- Version affected
- Potential impact

### Response timeline

| Action | Target |
|--------|--------|
| Acknowledge report | 48 hours |
| Assess severity | 7 days |
| Release fix | 30 days |

## Scope

Vocal Synth Engine is a **deterministic vocal instrument engine** with WebSocket streaming.

- **Data touched:** Audio synthesis (in-memory), WebSocket connections (localhost), WAV file output, score data, voice presets
- **Data NOT touched:** No telemetry, no analytics, no cloud sync, no credentials stored
- **Permissions:** Network: WebSocket server on localhost. Disk: WAV file output to user-specified paths
- **No telemetry** is collected or sent

## Dependency Scanning Policy

- **CI audit threshold:** `npm audit --audit-level=high --omit=dev` runs on every push, PR, and weekly (Monday 06:00 UTC).
- **Blocking severity:** `high` and `critical` block CI. `moderate` and `low` are reported but do not block.
- **Update mechanism:** Dependabot opens monthly grouped npm + GitHub Actions + Docker PRs.
