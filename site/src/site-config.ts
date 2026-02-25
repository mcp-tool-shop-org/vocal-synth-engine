import type { SiteConfig } from '@mcptoolshop/site-theme';

export const config: SiteConfig = {
  title: 'Vocal Synth Engine',
  description: 'Deterministic vocal instrument engine — additive synthesis, voice presets, real-time WebSocket streaming, multi-user jam sessions, cockpit UI',
  logoBadge: 'VS',
  brandName: 'Vocal Synth Engine',
  repoUrl: 'https://github.com/mcp-tool-shop-org/vocal-synth-engine',
  footerText: 'MIT Licensed — built by <a href="https://github.com/mcp-tool-shop-org" style="color:var(--color-muted);text-decoration:underline">mcp-tool-shop-org</a>',

  hero: {
    badge: 'Open source',
    headline: 'Vocal Synth Engine.',
    headlineAccent: 'Sing with code.',
    description: 'A deterministic vocal instrument engine. Render singing voices from score data using additive synthesis, 15 voice presets, and real-time WebSocket streaming. Play live, jam with others, or render to WAV.',
    primaryCta: { href: '#quick-start', label: 'Get started' },
    secondaryCta: { href: '#features', label: 'Explore features' },
    previews: [
      { label: 'Clone', code: 'git clone https://github.com/mcp-tool-shop-org/vocal-synth-engine.git' },
      { label: 'Run', code: 'npm ci && npm run dev' },
      { label: 'Open', code: 'http://localhost:4321  # cockpit UI' },
    ],
  },

  sections: [
    {
      kind: 'features',
      id: 'features',
      title: 'Features',
      subtitle: 'Everything you need to synthesize, play, and collaborate.',
      features: [
        { title: 'Additive Synthesis', desc: 'Harmonic partials, spectral envelopes, and noise residual combine to produce natural singing voices from pure math.' },
        { title: '15 Voice Presets', desc: 'Frozen analysis artifacts from Kokoro TTS voices plus lab presets, each with multiple timbres and binary .f32 assets.' },
        { title: 'Real-Time Streaming', desc: 'WebSocket audio streaming with latency calibration, hold pedal, velocity/breathiness sliders, and live telemetry.' },
        { title: 'Multi-User Jams', desc: 'Collaborative sessions with host authority, guest participation, track ownership, participant attribution, and shared recording.' },
        { title: 'Cockpit UI', desc: 'Browser-based SPA with piano roll editor, live chromatic keyboard, XY pad for timbre morphing, render bank, and telemetry.' },
        { title: 'Deterministic Output', desc: 'Seeded RNG ensures reproducible output from the same inputs. Every render includes provenance tracking with commit SHA and score hash.' },
      ],
    },
    {
      kind: 'code-cards',
      id: 'quick-start',
      title: 'Quick Start',
      cards: [
        {
          title: 'Development',
          code: `# Clone and start the dev server
git clone https://github.com/mcp-tool-shop-org/vocal-synth-engine.git
cd vocal-synth-engine
npm ci
npm run dev

# Open the cockpit UI at http://localhost:4321`,
        },
        {
          title: 'Production',
          code: `# Build everything (cockpit + server)
npm run build

# Start the production server
npm start

# Or deploy with Docker
docker build -t vocal-synth .
docker run -p 4321:4321 vocal-synth`,
        },
      ],
    },
    {
      kind: 'data-table',
      id: 'api',
      title: 'API Reference',
      subtitle: 'REST endpoints and WebSocket paths.',
      columns: ['Endpoint', 'Method', 'Description'],
      rows: [
        ['`/api/health`', 'GET', 'Server health, version, uptime'],
        ['`/api/presets`', 'GET', 'List voice presets with timbres and metadata'],
        ['`/api/phonemize`', 'POST', 'Convert lyrics text to phoneme events'],
        ['`/api/render`', 'POST', 'Render a score to WAV'],
        ['`/api/renders`', 'GET', 'List all saved renders'],
        ['`/api/renders/:id/audio.wav`', 'GET', 'Download render WAV file'],
        ['`/ws`', 'WS', 'Live mode — single-user note playback'],
        ['`/ws/jam`', 'WS', 'Jam sessions — multi-user collaboration'],
      ],
    },
    {
      kind: 'features',
      id: 'cockpit',
      title: 'Cockpit UI',
      subtitle: 'Three tabs, one instrument.',
      features: [
        { title: 'Score Editor', desc: 'Piano roll with drag-to-create notes (C2-C6), per-note velocity/timbre/breathiness controls, lyrics input with phoneme generation.' },
        { title: 'Live Mode', desc: '24-key chromatic keyboard with MIDI input, XY pad for real-time timbre morphing, hold pedal, metronome with quantize grid.' },
        { title: 'Render Bank', desc: 'Browse, play, pin, rename, and delete saved renders. Load scores back into the editor. Side-by-side telemetry comparison.' },
      ],
    },
  ],
};
