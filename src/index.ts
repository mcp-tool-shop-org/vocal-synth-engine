/**
 * @mcptoolshop/vocal-synth-engine — public library entry.
 *
 * This file is the canonical import surface for the engine when consumers
 * pull it in via `import { ... } from '@mcptoolshop/vocal-synth-engine'`.
 * The package's `main` and `types` fields point here, and the `exports`
 * map advertises this as the `"."` entry. The Express server lives behind
 * the `"./server"` subpath and is NOT pulled in transitively when only
 * the engine surface is required.
 *
 * FE-001: prior to this file the package's `main` pointed at the server
 * bootstrap, so `npm install` of the engine pulled in Express + ws + pino
 * and the engine surface was not directly importable without reaching
 * into `dist/...` paths.
 */

// ── Live (imperative real-time) engine ──────────────────────────
export { LiveSynthEngine } from './engine/LiveSynthEngine.js';
export type {
  LiveEngineConfig,
  LiveVoiceParams,
  LiveTelemetry,
} from './engine/LiveSynthEngine.js';

// ── Streaming (score-driven) engine ─────────────────────────────
export { StreamingVocalSynthEngine } from './engine/StreamingVocalSynthEngine.js';
export type {
  StreamingVocalSynthConfig,
  StreamingTelemetry,
} from './engine/StreamingVocalSynthEngine.js';

// ── Renderer (low-level monophonic) ─────────────────────────────
export { MonophonicRenderer } from './engine/renderer.js';
export type {
  RenderParams,
  RendererTelemetry,
  BlockRenderer,
} from './engine/renderer.js';

// ── DSP / curve helpers ─────────────────────────────────────────
export {
  midiToHz,
  hzToMidi,
  centsToRatio,
  calculateVibrato,
  calculateAdsr,
  interpAutomation,
  interpLinear,
  dbToLinear,
  fastSin,
  xorshift32,
} from './engine/curves.js';

// ── Consonant profiles ──────────────────────────────────────────
export {
  CONSONANT_PROFILES,
  getConsonantProfile,
  consonantEnvelope,
} from './engine/consonantProfiles.js';
export type {
  ConsonantProfile,
  ConsonantEnvelopeKind,
} from './engine/consonantProfiles.js';

// ── Preset loader + schema ──────────────────────────────────────
export {
  loadVoicePreset,
  computeAssetsHash,
  SUPPORTED_PRESET_VERSIONS,
} from './preset/loader.js';
export { VoicePresetSchema } from './preset/schema.js';
export type {
  VoicePresetManifest,
  LoadedVoicePreset,
  LoadedTimbre,
} from './preset/schema.js';

// ── Score types + Zod validator ─────────────────────────────────
export {
  VocalScoreSchema,
  parseVocalScore,
  SUPPORTED_SCORE_VERSIONS,
} from './types/scoreSchema.js';
export type {
  VocalScore,
  VocalNote,
  PhonemeEvent,
  AutomationPoint,
  TimbreId,
} from './types/score.js';
export type { VocalScoreParsed } from './types/scoreSchema.js';
