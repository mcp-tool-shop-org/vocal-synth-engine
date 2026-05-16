# Cockpit — Vocal Synth Engine Operator UI

Browser-based single-page application that drives the Vocal Synth Engine daemon. Built with **Vite + vanilla TypeScript** (no UI framework). Served at the root path of the daemon in production; runs standalone on a dev server in development.

## What's in this package

```
apps/cockpit/
├── index.html           ← Vite entry — full UI markup + inline CSS
├── src/
│   ├── main.ts          ← App logic: render bank, transport, live, jams, MIDI, XY pad
│   ├── auth.ts          ← API-key store + authFetch / WS token suffix (FS-009)
│   ├── waveform.ts      ← Static waveform + live AnalyserNode scope (FCD-001)
│   └── pages/           ← Stale Astro scaffold — unused; see FCD-007
├── public/              ← AudioWorklet (`pcm-worklet.js`) + static assets
├── package.json         ← Vite-only — NOT an Astro app
├── tsconfig.json
└── README.md            ← You are here
```

The three tabs visible in the UI:

| Tab        | What it does                                                                                       |
|------------|----------------------------------------------------------------------------------------------------|
| **Score**  | Piano roll, lyrics → phonemes, note inspector, render bank, transport (Render, Save, Play, Loop). |
| **Live**   | Real-time WS streaming with on-screen keyboard, MIDI input, XY timbre pad, metronome, scope.       |
| **Jams**   | Multi-user collaborative sessions (host authority, participant attribution, recording).            |

## Dev / Build commands

```bash
npm install                # one-time, from this directory
npm run dev                # Vite dev server at http://localhost:5173
npm run build              # production build → dist/  (this is what the daemon serves)
npm run preview            # preview dist/ locally on a stand-alone port
```

In a typical workflow you run the daemon (`npm run dev` from the repo root) on its own port and the cockpit dev server (`npm run dev` from this directory) on Vite's port; the cockpit hits the daemon at the same origin in production and via the proxy in dev.

## Environment / runtime settings

The cockpit talks to the daemon at the same origin by default (`DAEMON_URL = ''` in `src/main.ts`). In split-deploy setups, the daemon URL is fixed at build time — change the constant or wire it through `import.meta.env`.

| Setting                   | Where                       | Purpose                                                                                                                        |
|---------------------------|-----------------------------|--------------------------------------------------------------------------------------------------------------------------------|
| `API_BASE`                | Build-time / inline string  | If you split the cockpit from the daemon, set `DAEMON_URL` to the daemon origin. Default empty = same-origin.                  |
| `AUTH_TOKEN` (operator)   | localStorage, set via UI    | Stored in the browser when the operator pastes their daemon `AUTH_TOKEN` into the **🔑 API Key** header button.                |

The cockpit never reads `AUTH_TOKEN` from the environment — it asks the operator for it interactively (FS-009). All `fetch` calls go through `authFetch` which adds `Authorization: Bearer <token>` when set, and surfaces 401 responses by opening the API-key panel automatically.

## Production build

`npm run build` produces `dist/` (a static folder with `index.html`, hashed JS, and AudioWorklet). The daemon serves this folder verbatim — see `src/server/index.prod.ts` for the static-file middleware. There is no SSR; the cockpit is fully client-rendered.

## Cross-references

- **Server REST + WS API** — see [`site/src/content/docs/handbook/reference.md`](../../site/src/content/docs/handbook/reference.md)
- **Cockpit UI layout + Jam protocol** — see [`site/src/content/docs/handbook/cockpit-and-jams.md`](../../site/src/content/docs/handbook/cockpit-and-jams.md)
- **Auth contract** — see `src/server/middleware/auth.ts` for the Bearer rules and `apps/cockpit/src/auth.ts` for the client side.
