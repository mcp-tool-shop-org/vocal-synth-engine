<p align="center">
  <a href="README.md">English</a> ·
  <a href="README.ja.md">日本語</a> ·
  <a href="README.zh.md">中文</a> ·
  <a href="README.es.md">Español</a> ·
  <a href="README.fr.md">Français</a> ·
  <a href="README.hi.md">हिन्दी</a> ·
  <a href="README.it.md">Italiano</a> ·
  <a href="README.pt-BR.md">Português</a>
</p>

<p align="center">
  
            <img src="https://raw.githubusercontent.com/mcp-tool-shop-org/brand/main/logos/vocal-synth-engine/readme.png"
           alt="Vocal Synth Engine" width="400" />
</p>

<p align="center">
  <a href="https://github.com/mcp-tool-shop-org/vocal-synth-engine/actions/workflows/ci.yml"><img src="https://github.com/mcp-tool-shop-org/vocal-synth-engine/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <img src="https://img.shields.io/badge/license-MIT-blue" alt="License: MIT">
  <a href="https://mcp-tool-shop-org.github.io/vocal-synth-engine/"><img src="https://img.shields.io/badge/Landing_Page-live-blue" alt="Landing Page"></a>
</p>

<p align="center"><strong>Deterministic vocal instrument engine — additive synthesis, voice presets, real-time WebSocket streaming, multi-user jam sessions, cockpit UI</strong></p>

Un motore per strumenti vocali deterministico, sviluppato in TypeScript. Genera voci cantate a partire da dati musicali, utilizzando la sintesi additiva, preset vocali e streaming WebSocket in tempo reale. È possibile suonare in diretta tramite tastiera/MIDI, collaborare in sessioni musicali con più utenti o generare file audio WAV a partire dalle partiture.

## Funzionalità

- **Sintesi vocale additiva** — armoniche + inviluppo spettrale + rumore residuo
- **15 preset vocali** — analisi preesistenti delle voci Kokoro TTS + preset di laboratorio, ognuno con diverse timbriche
- **Rendering polifonico** — polifonia massima configurabile, con gestione dello stato per ogni voce e possibilità di "rubare" le voci
- **Modalità live** — possibilità di suonare note tramite tastiera o MIDI, con streaming audio WebSocket in tempo reale
- **Sessioni musicali collaborative** — sessioni collaborative con più utenti, con un utente "host" che ha l'autorità, attribuzione dei partecipanti e possibilità di registrazione
- **Importazione di partiture** — caricare una `VocalScore` in una traccia per la riproduzione automatica sincronizzata con il tempo
- **Registrazione ed esportazione** — registrare le performance e esportarle in formato WAV, con informazioni complete sulla provenienza
- **Testi e fonemi** — pipeline da grafemi a fonemi, con visualizzazione della "corsia" dei fonemi
- **Interfaccia utente (Cockpit)** — applicazione web SPA (Single Page Application) con editor di piano roll, tastiera virtuale, pad XY, libreria di preset e telemetria
- **Determinismo** — generazione di numeri casuali con seme, output riproducibile a partire dagli stessi input

## Architettura

```
                          ┌─── Cockpit UI (browser SPA) ───┐
                          │  Piano Roll  │  Live  │ Renders │
                          └──────────────┴────────┴─────────┘
                                     │        │
                              REST API    WebSocket
                                     │    /ws  /ws/jam
                          ┌──────────┴────────┴─────────────┐
                          │        Express Server            │
                          │  Render API │ Jam Sessions       │
                          └──────┬──────┴───────┬────────────┘
                                 │              │
                      StreamingVocalSynthEngine  │
                        LiveSynthEngine ─────────┘
                                 │
                    ┌────────────┼─────────────┐
              VoicePreset    DSP (FFT)    Curves (ADSR,
              (.f32 blobs)   Pitch Det.   vibrato, automation)
```

**Directory principali:**

| Directory | Scopo |
| ----------- | --------- |
| `src/engine/` | Core synth — motore di rendering, sistema di streaming, curve ADSR/vibrato |
| `src/dsp/` | Elaborazione del segnale — FFT, rilevamento dell'intonazione |
| `src/preset/` | Schema, caricatore e risolutore dei preset vocali |
| `src/server/` | Server API Express + WebSocket, gestore delle sessioni musicali |
| `src/types/` | Tipi condivisi — partiture, protocollo delle sessioni musicali, preset |
| `src/cli/` | Strumenti a riga di comando (CLI) + suite di test di integrazione |
| `apps/cockpit/` | Interfaccia utente (Cockpit) per browser (Vite + TypeScript puro) |
| `presets/` | 15 preset vocali inclusi, con dati di timbrica in formato binario |

## Guida rapida

```bash
npm ci
npm run dev
```

Il server di sviluppo si avvia all'indirizzo `http://localhost:4321`. L'interfaccia utente (Cockpit) è disponibile sulla stessa porta.

## Interfaccia utente (Cockpit)

L'interfaccia utente è un'applicazione web SPA con tre schede:

### Editor di partiture
- Piano roll con possibilità di creare, spostare e ridimensionare le note tramite trascinamento (intervallo C2-C6)
- Controlli per ogni nota: velocità, timbrica, "respiro", vibrato, portamento
- Inserimento di testi con generazione automatica dei fonemi
- Sovrapposizione della "corsia" dei fonemi sincronizzata con il piano roll
- Generazione di file WAV con preset, polifonia, seme e BPM configurabili

### Modalità live
- Tastiera cromatica a 24 tasti (mouse + associazioni di tasti)
- Input da dispositivo MIDI con filtraggio dei canali
- Pad XY per la modifica in tempo reale della timbrica (asse X) e del "respiro" (asse Y)
- Pedale di sustain, slider di velocità/respiro, controlli del vibrato
- Metronomo con griglia di quantizzazione (1/4, 1/8, 1/16)
- Calibrazione della latenza (preset "bassa", "equilibrata" e "sicura")
- Registrazione delle performance e salvataggio nella libreria di preset
- Telemetria in tempo reale: voci, picco dBFS, RTF (Real-Time Factor), rischio di "click", jitter del WebSocket

### Libreria di preset
- Esplorazione, riproduzione, salvataggio, ridenominazione ed eliminazione dei preset salvati
- Caricamento della partitura di un preset nell'editor
- Confronto affiancato della telemetria tra diversi preset
- Tracciamento della provenienza: commit SHA, hash della partitura, hash del file WAV

## Sessioni musicali collaborative

Sessioni collaborative con più utenti tramite WebSocket (`/ws/jam`):

- **Autorità dell'host** — il creatore della sessione controlla il trasporto, le tracce, la registrazione e la quantizzazione.
- **Partecipazione degli ospiti** — gli ospiti possono suonare note su qualsiasi traccia, ma non possono modificare lo stato della sessione.
- **Proprietà delle tracce** — le tracce appartengono al loro creatore; solo il proprietario o l'host possono modificarle/eliminarle.
- **Attribuzione dei partecipanti** — ogni evento di nota nell'EventTape registra chi l'ha suonata.
- **Modalità di inserimento della partitura** — carica una `VocalScore` in una traccia per la riproduzione automatica sincronizzata con il trasporto.
- **Registrazione** — registra le note di tutti i partecipanti nell'EventTape, esporta in formato WAV.
- **Metronomo** — metronomo condiviso con BPM e tempo configurabili.

### Jam Protocol

I client si connettono a `/ws/jam` e scambiano messaggi JSON:

```
Client: jam_hello → Server: jam_hello_ack (participantId)
Client: session_create → Server: session_created (snapshot)
Client: session_join → Server: session_joined (snapshot)
Client: track_note_on/off → Server: track_note_ack
Client: record_start/stop → Server: record_status
Client: record_export → Server: record_exported (renderId)
Client: track_set_score → Server: score_status
```

## API

| Endpoint | Metodo | Auth | Descrizione |
| ---------- | -------- | ------ | ------------- |
| `/api/health` | GET | No | Stato del server, versione, uptime |
| `/api/presets` | GET | No | Elenco delle impostazioni predefinite per le voci, con timbri e metadati. |
| `/api/phonemize` | POST | Yes | Conversione di un testo di testo in eventi fonetici. |
| `/api/render` | POST | Yes | Generazione di una partitura in formato WAV. |
| `/api/renders` | GET | Yes | Elenco di tutte le generazioni salvate. |
| `/api/renders/:id/audio.wav` | GET | Yes | Download della generazione in formato WAV. |
| `/api/renders/:id/score` | GET | Yes | Partitura JSON originale. |
| `/api/renders/:id/meta` | GET | Yes | Metadati della generazione. |
| `/api/renders/:id/telemetry` | GET | Yes | Telemetria della generazione (picco, RTF, click). |
| `/api/renders/:id/provenance` | GET | Yes | Provenienza (commit, hash, configurazione). |

L'autenticazione è facoltativa: è abilitata quando la variabile `AUTH_TOKEN` è impostata nell'ambiente.

### WebSocket

| Path | Scopo |
| ------ | --------- |
| `/ws` | Modalità live: riproduzione di note per un singolo utente con streaming audio. |
| `/ws/jam` | Sessioni Jam: collaborazione multiutente con registrazione. |

## Impostazioni predefinite per le voci

15 impostazioni predefinite incluse, con supporto multi-timbro:

| Impostazione predefinita | Voice | Timbri |
| -------- | ------- | --------- |
| `default-voice` | Baseline femminile | Timbro predefinito |
| `bright-lab` | Laboratorio/sperimentale | Formante brillante |
| `kokoro-af-*` | Aoede, Heart, Jessica, Sky | Multipli per voce |
| `kokoro-am-*` | Eric, Fenrir, Liam, Onyx | Multipli per voce |
| `kokoro-bf-*` | Alice, Emma, Isabella | Multipli per voce |
| `kokoro-bm-*` | George, Lewis | Multipli per voce |

Ogni impostazione predefinita include file binari `.f32` (ampiezze armoniche, inviluppo spettrale, rumore di fondo) e un file manifest JSON che descrive l'intervallo di altezze, la risonanza e le impostazioni predefinite del vibrato.

## Script

```bash
npm run dev          # Dev server with hot reload
npm run build        # Build cockpit + server
npm start            # Production server
npm run inspect      # CLI preset inspector
```

## Test

I test di integrazione vengono eseguiti su un server di sviluppo attivo:

```bash
# Start the server first
npm run dev

# Then in another terminal:
npx tsx src/cli/test-jam-session.ts        # Jam session lifecycle (12 tests)
npx tsx src/cli/test-jam-recording.ts      # Recording & export (10 tests)
npx tsx src/cli/test-jam-collaboration.ts  # Collaboration & score input (12 tests)
npx tsx src/cli/test-score-render.ts       # Score rendering pipeline
npx tsx src/cli/test-consonants.ts         # Consonant phonemes
npx tsx src/cli/test-g2p.ts               # Grapheme-to-phoneme
npx tsx src/cli/test-lyrics-golden.ts      # Lyrics golden tests
npx tsx src/cli/test-multi-timbre.ts       # Multi-timbre rendering
npx tsx src/cli/test-noise-tail.ts         # Tail silence/noise
```

## Licenza

MIT. Vedi [LICENSE](LICENSE).
