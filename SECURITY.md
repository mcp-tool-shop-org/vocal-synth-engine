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
