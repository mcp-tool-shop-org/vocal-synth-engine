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
  <img src="assets/logo.png" alt="Vocal Synth Engine" width="400" />
</p>

<p align="center">
  <a href="https://github.com/mcp-tool-shop-org/vocal-synth-engine/actions/workflows/ci.yml"><img src="https://github.com/mcp-tool-shop-org/vocal-synth-engine/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <img src="https://img.shields.io/badge/license-MIT-blue" alt="License: MIT">
  <a href="https://mcp-tool-shop-org.github.io/vocal-synth-engine/"><img src="https://img.shields.io/badge/Landing_Page-live-blue" alt="Landing Page"></a>
</p>

<p align="center"><strong>Deterministic vocal instrument engine — additive synthesis, voice presets, real-time WebSocket streaming, multi-user jam sessions, cockpit UI</strong></p>

Un moteur d'instrument vocal déterministe, développé en TypeScript. Il génère des voix chantées à partir de données de partition en utilisant la synthèse additive, des préréglages de voix et un streaming WebSocket en temps réel. Possibilité de jouer en direct via un clavier/MIDI, de collaborer lors de sessions musicales multi-utilisateurs, ou de convertir les partitions en fichiers WAV.

## Fonctionnalités

- **Synthèse vocale additive** : harmoniques + enveloppe spectrale + bruit résiduel.
- **15 préréglages de voix** : analyses préexistantes des voix Kokoro TTS + préréglages de laboratoire, chacun avec plusieurs timbres.
- **Rendu polyphonique** : polyphonie maximale configurable, gestion de l'état de chaque voix et possibilité de "voler" des voix.
- **Mode live** : lecture de notes via un clavier ou un MIDI, avec streaming audio WebSocket en temps réel.
- **Sessions musicales** : sessions collaboratives multi-utilisateurs avec un hôte, attribution des participants et enregistrement.
- **Importation de partitions** : chargement d'une partition `VocalScore` dans une piste pour une lecture automatique synchronisée avec le transport.
- **Enregistrement et exportation** : capture des performances en direct dans un fichier EventTape, exportation en format WAV avec toutes les informations de provenance.
- **Paroles et phonèmes** : pipeline de conversion de graphèmes en phonèmes avec visualisation de la piste des phonèmes.
- **Interface utilisateur (Cockpit)** : application web unique (SPA) basée sur un navigateur, avec un éditeur de piano roll, un clavier live, un pavé XY, une banque de rendus et des informations de télémétrie.
- **Déterministe** : générateur de nombres aléatoires (RNG) initialisé, sortie reproductible à partir des mêmes entrées.

## Architecture

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

**Répertoires principaux :**

| Répertoire | Fonction |
| ----------- | --------- |
| `src/engine/` | Moteur de synthèse principal : rendu par blocs, moteur de streaming, courbes ADSR/vibrato. |
| `src/dsp/` | Traitement du signal : FFT, détection de la hauteur. |
| `src/preset/` | Schéma, chargeur et résolveur des préréglages de voix. |
| `src/server/` | Serveur API Express + WebSocket, gestionnaire de sessions musicales. |
| `src/types/` | Types partagés : partitions, protocole de session musicale, préréglages. |
| `src/cli/` | Outils en ligne de commande (CLI) + suites de tests d'intégration. |
| `apps/cockpit/` | Interface utilisateur (Cockpit) pour navigateur (Vite + TypeScript natif). |
| `presets/` | 15 préréglages de voix regroupés avec des données de timbre binaires. |

## Démarrage rapide

```bash
npm ci
npm run dev
```

Le serveur de développement démarre à l'adresse `http://localhost:4321`. L'interface utilisateur (Cockpit) est servie à partir du même port.

## Interface utilisateur (Cockpit)

L'interface utilisateur est une application web unique (SPA) basée sur un navigateur, avec trois onglets :

### Éditeur de partition
- Piano roll avec possibilité de créer, déplacer et redimensionner les notes par glisser-déposer (gamme C2-C6).
- Contrôles par note : vélocité, timbre, souffle, vibrato, portamento.
- Saisie de paroles avec génération automatique de phonèmes.
- Superposition de la piste des phonèmes synchronisée avec le piano roll.
- Rendu en format WAV avec préréglage, polyphonie, seed et BPM configurables.

### Mode live
- Clavier chromatique à 24 touches (souris + liaisons de touches).
- Entrée d'un périphérique MIDI avec filtrage des canaux.
- Pavé XY pour la morphologie du timbre en temps réel (axe X) et du souffle (axe Y).
- Pédale de sustain, curseurs de vélocité/souffle, contrôles de vibrato.
- Métronome avec grille de quantification (1/4, 1/8, 1/16).
- Calibrage de la latence (préréglages faible, équilibré, sûr).
- Enregistrement des performances et sauvegarde dans la banque de rendus.
- Télémétrie en direct : voix, niveau de crête en dBFS, RTF, risque de clics, gigue du WebSocket.

### Banque de rendus
- Parcourir, lire, épingler, renommer et supprimer les rendus enregistrés.
- Charger la partition d'un rendu dans l'éditeur.
- Comparaison côte à côte des informations de télémétrie entre les rendus.
- Suivi de la provenance : commit SHA, hachage de la partition, hachage du fichier WAV.

## Sessions musicales

Sessions collaboratives multi-utilisateurs via WebSocket (`/ws/jam`) :

- **Autorité de l'hôte** : le créateur de la session contrôle le transport, les pistes, l'enregistrement et la quantification.
- **Participation des invités** : les invités peuvent jouer des notes sur n'importe quelle piste, mais ne peuvent pas modifier l'état de la session.
- **Propriété des pistes** : les pistes appartiennent à leur créateur ; seul le propriétaire ou l'hôte peut les modifier/supprimer.
- **Attribution des participants** : chaque événement de note dans l'EventTape enregistre qui l'a joué.
- **Mode de saisie de partition** : chargez une `VocalScore` dans une piste pour une lecture automatique synchronisée avec le transport.
- **Enregistrement** : capturez les notes de tous les participants dans un EventTape, exportez au format WAV.
- **Métronome** : métronome partagé avec un BPM et une signature temporelle configurables.

### Protocole Jam

Les clients se connectent à `/ws/jam` et échangent des messages JSON :

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

| Point de terminaison | Méthode | Auth | Description |
| ---------- | -------- | ------ | ------------- |
| `/api/health` | GET | No | État du serveur, version, temps de fonctionnement |
| `/api/presets` | GET | No | Liste des préréglages vocaux avec les timbres et les métadonnées. |
| `/api/phonemize` | POST | Yes | Convertit un texte de paroles en événements phonétiques. |
| `/api/render` | POST | Yes | Génère une partition au format WAV. |
| `/api/renders` | GET | Yes | Liste de toutes les générations enregistrées. |
| `/api/renders/:id/audio.wav` | GET | Yes | Téléchargement de la génération au format WAV. |
| `/api/renders/:id/score` | GET | Yes | Partition JSON originale. |
| `/api/renders/:id/meta` | GET | Yes | Métadonnées de la génération. |
| `/api/renders/:id/telemetry` | GET | Yes | Télémétrie de la génération (pic, RTF, clics). |
| `/api/renders/:id/provenance` | GET | Yes | Provenance (commit, hachages, configuration). |

L'authentification est facultative et est activée lorsque la variable d'environnement `AUTH_TOKEN` est définie.

### WebSocket

| Path | Objectif |
| ------ | --------- |
| `/ws` | Mode live : lecture de notes en solo avec diffusion audio. |
| `/ws/jam` | Sessions Jam : collaboration multi-utilisateurs avec enregistrement. |

## Préréglages vocaux

15 préréglages intégrés avec prise en charge de plusieurs timbres :

| Préréglage | Voice | Timbres |
| -------- | ------- | --------- |
| `default-voice` | Voix féminine par défaut | Timbre par défaut |
| `bright-lab` | Laboratoire/expérimental | Formant brillant |
| `kokoro-af-*` | Aoede, Heart, Jessica, Sky | Plusieurs par voix |
| `kokoro-am-*` | Eric, Fenrir, Liam, Onyx | Plusieurs par voix |
| `kokoro-bf-*` | Alice, Emma, Isabella | Plusieurs par voix |
| `kokoro-bm-*` | George, Lewis | Plusieurs par voix |

Chaque préréglage comprend des ressources binaires `.f32` (amplitudes harmoniques, enveloppe spectrale, niveau de bruit) et un manifeste JSON décrivant la plage de hauteur, la résonance et les valeurs par défaut du vibrato.

## Scripts

```bash
npm run dev          # Dev server with hot reload
npm run build        # Build cockpit + server
npm start            # Production server
npm run inspect      # CLI preset inspector
```

## Tests

Les tests d'intégration sont exécutés sur un serveur de développement en direct :

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

## Licence

MIT. Voir [LICENSE](LICENSE).
