<p align="center">
  <a href="README.ja.md">日本語</a> | <a href="README.zh.md">中文</a> | <a href="README.es.md">Español</a> | <a href="README.md">English</a> | <a href="README.hi.md">हिन्दी</a> | <a href="README.it.md">Italiano</a> | <a href="README.pt-BR.md">Português (BR)</a>
</p>

<p align="center">
  <img src="https://raw.githubusercontent.com/mcp-tool-shop-org/brand/main/logos/vocal-synth-engine/readme.png" alt="Vocal Synth Engine" width="400" />
</p>

<p align="center">
  <a href="https://github.com/mcp-tool-shop-org/vocal-synth-engine/actions/workflows/ci.yml"><img src="https://github.com/mcp-tool-shop-org/vocal-synth-engine/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <img src="https://img.shields.io/badge/license-MIT-blue" alt="License: MIT">
  <img src="https://img.shields.io/badge/node-%3E%3D20-339933?logo=node.js&logoColor=white" alt="Node >=20">
  <img src="https://img.shields.io/badge/status-pre--release-orange" alt="Status: pre-release">
</p>

<p align="center"><strong>Moteur d'instrument vocal déterministe : synthèse additive, préréglages vocaux, diffusion en temps réel via WebSocket, sessions de jam multijoueurs, interface utilisateur intuitive.</strong></p>

Un moteur d'instrument vocal déterministe, développé en TypeScript. Il génère des voix chantées à partir de données musicales, en utilisant la synthèse additive, des préréglages de voix et une diffusion WebSocket en temps réel. Possibilité de jouer en direct via un clavier/MIDI, de collaborer lors de sessions musicales multijoueurs, ou de convertir les partitions en fichiers WAV.

**Statut :** version 1.0.3, code source — pas encore publié sur npm. Installez à partir du code source jusqu'à la publication de la version 1.0.4 (voir [Installation](#installation)).

## Ce que cela fait

- **Synthèse vocale additive** — harmoniques + enveloppe spectrale + bruit résiduel.
- **15 préréglages de voix** — artefacts d'analyse dérivés des voix Kokoro TTS, ainsi que des préréglages de laboratoire, chacun avec plusieurs timbres.
- **Rendu polyphonique** — polyphonie maximale configurable, avec gestion de l'état de chaque voix et possibilité de "vol de voix".
- **Mode live** — lecture de notes via clavier ou MIDI, avec diffusion audio en temps réel via WebSocket.
- **Sessions de jam** — sessions collaboratives multi-utilisateurs, avec un hôte ayant l'autorité, attribution des participants et possibilité d'enregistrement.
- **Importation de partitions** — chargement d'une partition vocale (`VocalScore`) dans une piste pour une lecture automatique synchronisée avec le transport.
- **Enregistrement et exportation** — enregistrement des performances en direct dans une bande d'événements, exportation au format WAV avec toutes les informations de provenance.
- **Paroles et phonèmes** — pipeline de conversion des graphèmes en phonèmes, avec visualisation des "pistes" de phonèmes.
- **Interface utilisateur (Cockpit)** — application web unique (SPA) accessible via navigateur, avec éditeur de piano, clavier en direct, pavé XY, banque de rendus et données télémétriques.
- **Déterministe** — générateur de nombres aléatoires initialisé, résultats reproductibles à partir des mêmes entrées.

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

**Répertoires importants :**

| Répertoire. | Objectif. |
|-----------|---------|
| `src/engine/` | Synthèse de base : rendu par blocs, moteur de streaming, courbes ADSR/vibrato. |
| `src/dsp/` | Traitement du signal — Transformée de Fourier rapide (FFT), détection de la hauteur. |
| `src/preset/` | Schéma, chargeur et résolveur pour les paramètres vocaux. |
| `src/server/` | Serveur d'API WebSocket pour Express, gestionnaire de sessions musicales collaboratives. |
| `src/types/` | Types partagés : scores, protocole de synchronisation, préréglages. |
| `src/cli/` | Outils en ligne de commande destinés aux utilisateurs (analyze, build-preset, compare, inspect, play-score, resynth, gen-vowel-wav, realtime-demo). |
| `scripts/` | Créer/tester des scripts de régression (non inclus dans la distribution, et ne faisant pas partie de `npm test`). |
| `apps/cockpit/` | Interface utilisateur du navigateur, conçue avec Vite et TypeScript natif. |
| `presets/` | 15 préréglages vocaux regroupés, avec des données de timbre binaires. |

## Installer

Le paquet `@mcptoolshop/vocal-synth-engine` n'a pas encore été publié sur npm. Jusqu'à la version 1.0.4, veuillez l'installer directement à partir du code source :

```bash
git clone https://github.com/mcp-tool-shop-org/vocal-synth-engine.git
cd vocal-synth-engine
npm ci
npm run build
```

Pour fixer une version spécifique dans un projet dérivé :

```bash
npm install github:mcp-tool-shop-org/vocal-synth-engine#<commit-sha>
```

## Démarrage rapide

```bash
npm ci
npm run dev
```

Le serveur de développement démarre à l'adresse `http://localhost:4321`. L'interface utilisateur du cockpit est également accessible via le même port.

## Interface utilisateur du poste de pilotage

Le tableau de bord est une application web unique (SPA) accessible via un navigateur, et il comprend trois onglets :

### Éditeur de partitions
- Clavier virtuel permettant de créer, déplacer et redimensionner les notes par glisser-déposer (gamme de C2 à C6).
- Contrôles individuels pour chaque note : vélocité, timbre, expressivité, vibrato, portamento.
- Saisie de paroles avec génération automatique des phonèmes.
- Affichage des phonèmes synchronisé avec le clavier virtuel.
- Possibilité d'exporter en format WAV avec des paramètres configurables : polyphonie, "seed" (graine), et tempo (BPM).

### Mode en direct
- Clavier chromatique de 24 touches (souris + raccourcis clavier)
- Entrée MIDI avec filtrage des canaux
- Pavé XY pour la modification en temps réel de la timbrure (axe X) et de la respiration (axe Y)
- Pédale de sustain, curseurs de vélocité/respiration, contrôles de vibrato
- Métronome avec grille de quantification (1/4, 1/8, 1/16)
- Calibration de la latence (préréglages : faible, équilibré, sûr)
- Enregistrement des performances et sauvegarde dans la banque de rendus
- Télémetrie en direct : nombre de voix, niveau de crête en dBFS, RTF (Retard Temporel Total), risque de clics, gigue du WS (Waveform Synthesis).

### Rendu bancaire
- Parcourir, lire, épingler, renommer et supprimer les rendus enregistrés.
- Charger le score d'un rendu dans l'éditeur.
- Comparaison côte à côte des données télémétriques entre les rendus.
- Suivi de la provenance : commit SHA, hachage du score, hachage WAV.

## Sessions de jam

Sessions collaboratives multi-utilisateurs via WebSocket (`/ws/jam`) :

- **Autorité de l'hôte** : le créateur de la session contrôle le transport, les pistes, l'enregistrement et la quantification.
- **Participation des invités** : les invités peuvent jouer des notes sur n'importe quelle piste, mais ne peuvent pas modifier l'état de la session.
- **Propriété des pistes** : les pistes appartiennent à leur créateur ; seul le propriétaire ou l'hôte peut les modifier/supprimer.
- **Attribution des participants** : chaque événement de note dans l'EventTape enregistre qui l'a joué.
- **Mode d'entrée de score** : charger un `VocalScore` dans une piste pour une lecture automatique synchronisée avec le transport.
- **Enregistrement** : capturer les notes de tous les participants dans un EventTape, exporter au format WAV.
- **Métronome** : métronome partagé avec un BPM et une signature temporelle configurables.

### Protocole de jam

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

| Point de terminaison | Méthode | Authentification | Description |
|----------|--------|------|-------------|
| `/api/health` | GET | No | État du serveur, version, temps de fonctionnement. |
| `/api/presets` | GET | No | Liste des préréglages vocaux avec les timbres et les métadonnées. |
| `/api/phonemize` | POST | Oui | Convertir le texte des paroles en événements phonétiques. |
| `/api/render` | POST | Oui | Rendre un score au format WAV. |
| `/api/renders` | GET | Oui | Lister tous les rendus enregistrés. |
| `/api/renders/:id/audio.wav` | GET | Oui | Télécharger le fichier WAV du rendu. |
| `/api/renders/:id/score` | GET | Oui | Score JSON original. |
| `/api/renders/:id/meta` | GET | Oui | Métadonnées du rendu. |
| `/api/renders/:id/telemetry` | GET | Oui | Données télémétriques du rendu (pic, RTF, clics). |
| `/api/renders/:id/provenance` | GET | Oui | Provenance (commit, hachages, configuration). |

L'authentification est facultative ; elle est activée lorsque `AUTH_TOKEN` est défini dans l'environnement. Les jetons peuvent être fournis via l'en-tête `Authorization: Bearer <token>` ou le paramètre de requête `?token=<token>`.

### WebSocket

| Chemin | Objectif. |
|------|---------|
| `/ws` | Mode live : lecture de notes en solo avec diffusion audio. |
| `/ws/jam` | Sessions de jam : collaboration multi-utilisateurs avec enregistrement. |

## Serveur MCP

`vocal-synth-engine` inclut un serveur MCP (Model Context Protocol) afin que les agents Claude et autres clients MCP puissent appeler le moteur directement, sans nécessiter de structure HTTP. Le démarrage se fait via l'entrée de programme `vocal-synth-engine-mcp` (transport stdio).

Outils exposés :

| Outil | Objectif. |
|------|---------|
| `render_score` | Rendre un VocalScore via un préréglage → WAV en base64 + données télémétriques. |
| `phonemize_text` | Texte des paroles → Événements phonétiques ARPAbet (alignés sur les notes si `notes` sont fournis). |
| `list_presets` | Énumérer les ID de préréglages disponibles (même structure que GET /api/presets). |
| `validate_score` | Analyser et valider le JSON VocalScore sans le rendre. |
| `inspect_preset` | Manifeste du préréglage + harmoniques/énergie par timbre (comme `vse-inspect --json`). |

L'intégrer dans une configuration Claude Desktop / Code :

```json
{
  "mcpServers": {
    "vocal-synth-engine": {
      "command": "npx",
      "args": ["-y", "@mcptoolshop/vocal-synth-engine", "vocal-synth-engine-mcp"]
    }
  }
}
```

## Préréglages vocaux

15 préréglages intégrés avec prise en charge de plusieurs timbres :

| Préréglage | Voix | Timbres |
|--------|-------|---------|
| `default-voice` | Féminine de base | Timbre par défaut |
| `bright-lab` | Laboratoire/expérimental | Formant brillant |
| `kokoro-af-*` | Aoede, Heart, Jessica, Sky | Plusieurs par voix |
| `kokoro-am-*` | Eric, Fenrir, Liam, Onyx | Plusieurs par voix |
| `kokoro-bf-*` | Alice, Emma, Isabella | Plusieurs par voix |
| `kokoro-bm-*` | George, Lewis | Plusieurs par voix |

Chaque préréglage inclut des ressources binaires `.f32` (amplitudes harmoniques, enveloppe spectrale, niveau de bruit) et un manifeste JSON décrivant la plage de hauteur, la résonance et les valeurs par défaut du vibrato.

## Scripts

```bash
npm run dev          # Dev server with hot reload
npm run build        # Build cockpit + server
npm start            # Production server
npm run inspect      # CLI preset inspector
```

## Tests

La principale surface de test est vitest :

```bash
npm test                # Run all unit + integration tests once
npm run test:watch      # Watch mode
npm run test:coverage   # Coverage report
```

Scripts de régression supplémentaires sous `scripts/` (nécessitent un serveur de développement en cours d'exécution pour les tests de jam ; les autres sont autonomes) :

```bash
npx tsx scripts/test-jam-session.ts        # Jam session lifecycle
npx tsx scripts/test-jam-recording.ts      # Recording & export
npx tsx scripts/test-jam-collaboration.ts  # Collaboration & score input
npx tsx scripts/test-score-render.ts       # Score rendering pipeline
npx tsx scripts/test-consonants.ts         # Consonant phonemes
npx tsx scripts/test-g2p.ts                # Grapheme-to-phoneme
npx tsx scripts/test-lyrics-golden.ts      # Lyrics golden tests
npx tsx scripts/test-multi-timbre.ts       # Multi-timbre rendering
npx tsx scripts/test-noise-tail.ts         # Tail silence/noise
```

Ces éléments sont prévus pour être migrés vers le répertoire `tests/integration/` dans vitest lors d'une prochaine version, ce qui leur permet de bénéficier automatiquement de la couverture de tests via `npm test`.

## Sécurité et portée des données

| Aspect | Détail |
|--------|--------|
| **Data touched** | Synthèse audio (en mémoire), connexions WebSocket (localhost), sortie de fichiers WAV, données de partition, préréglages vocaux. |
| **Data NOT touched** | Aucune télémétrie, aucune analyse, pas de synchronisation cloud, aucune information d'identification stockée. |
| **Permissions** | Réseau : serveur WebSocket sur localhost. Disque : sortie de fichiers WAV vers les chemins spécifiés par l'utilisateur. |
| **Network** | Serveur WebSocket uniquement sur localhost – aucune connexion sortante. |
| **Telemetry** | Aucune donnée collectée ou envoyée. |

Voir [SECURITY.md](SECURITY.md) pour signaler les vulnérabilités.

## Tableau de bord

| Catégorie | Score |
|----------|-------|
| A. Sécurité | 10 |
| B. Gestion des erreurs | 10 |
| C. Documentation pour les utilisateurs | 10 |
| D. Qualité du code | 10 |
| E. Identité (soft) | 10 |
| **Overall** | **50/50** |

> Audit complet : [SHIP_GATE.md](SHIP_GATE.md) · [SCORECARD.md](SCORECARD.md)

## Licence

MIT. Voir [LICENSE](LICENSE).
