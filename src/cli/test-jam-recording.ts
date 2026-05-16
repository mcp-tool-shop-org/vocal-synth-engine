/**
 * test-jam-recording.ts — Integration test for Phase 5B recording + quantization.
 *
 * Requires a running server: npx tsx src/server/index.dev.ts
 *
 * Tests:
 *  1. Connect + create session + add track
 *  2. Set quantize grid → quantize_ack
 *  3. Start recording → record_status { recording: true }
 *  4. Play + send notes → note acks received
 *  5. Stop recording → record_status { recording: false, eventCount > 0 }
 *  6. Export recording → record_exported { renderId, durationSec, wavHash }
 *  7. Verify render exists via REST API
 *  8. Metronome toggle → metronome_ack
 *  9. Metronome tick received during playback
 * 10. Second recording + export with no quantize (grid = 'none')
 */

import WebSocket from 'ws';
import http from 'node:http';

const PORT = Number(process.env.PORT ?? 4321);
const TOKEN = process.env.AUTH_TOKEN || '';
const SERVER = `ws://localhost:${PORT}/ws/jam`;
const PRESET = 'default-voice';

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string) {
  if (!condition) {
    failed++;
    console.error(`  FAIL: ${msg}`);
    throw new Error(`Assertion failed: ${msg}`);
  }
}

function connect(label: string): Promise<WebSocket> {
  const url = TOKEN ? `${SERVER}?token=${TOKEN}` : SERVER;
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.on('open', () => resolve(ws));
    ws.on('error', (err) => reject(new Error(`${label} connect failed: ${err.message}`)));
  });
}

function send(ws: WebSocket, msg: any): void {
  ws.send(JSON.stringify(msg));
}

function waitFor(ws: WebSocket, type: string, timeoutMs = 5000): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off('message', handler);
      reject(new Error(`Timeout waiting for '${type}'`));
    }, timeoutMs);

    const handler = (raw: any) => {
      let msg: any;
      try {
        const str = Buffer.isBuffer(raw) ? raw.toString('utf8') : raw.toString();
        if (str.charCodeAt(0) !== 0x7b) return; // skip binary audio frames
        msg = JSON.parse(str);
      } catch {
        return;
      }
      if (msg.type === type) {
        clearTimeout(timer);
        ws.off('message', handler);
        resolve(msg);
      }
    };
    ws.on('message', handler);
  });
}

/** Collect messages of a type for durationMs. */
function collectMessages(ws: WebSocket, type: string, durationMs: number): Promise<any[]> {
  return new Promise((resolve) => {
    const results: any[] = [];
    const handler = (raw: any) => {
      let msg: any;
      try {
        const str = Buffer.isBuffer(raw) ? raw.toString('utf8') : raw.toString();
        if (str.charCodeAt(0) !== 0x7b) return;
        msg = JSON.parse(str);
      } catch {
        return;
      }
      if (msg.type === type) results.push(msg);
    };
    ws.on('message', handler);
    setTimeout(() => {
      ws.off('message', handler);
      resolve(results);
    }, durationMs);
  });
}

function httpGet(path: string): Promise<any> {
  return new Promise((resolve, reject) => {
    http.get(`http://localhost:${PORT}${path}`, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error(`Invalid JSON from ${path}`)); }
      });
    }).on('error', reject);
  });
}

function pass(name: string) {
  passed++;
  console.log(`  PASS [${passed}]: ${name}`);
}

async function main() {
  console.log('=== Jam Recording Integration Test (Phase 5B) ===\n');

  // ── 1. Connect + create session + add track ───────────────────
  const client = await connect('Alice');

  send(client, { type: 'jam_hello', protocolVersion: 1, displayName: 'Alice' });
  const hello = await waitFor(client, 'jam_hello_ack');
  assert(typeof hello.participantId === 'string', 'Got participantId');

  send(client, { type: 'session_create', bpm: 120 });
  const created = await waitFor(client, 'session_created');
  const sessionId = created.snapshot.sessionId;
  assert(typeof sessionId === 'string', 'Got sessionId');

  send(client, { type: 'track_add', presetId: PRESET, name: 'Lead' });
  const trackAdded = await waitFor(client, 'track_added');
  const trackId = trackAdded.track.trackId;
  assert(typeof trackId === 'string', 'Got trackId');
  pass('Connect + create session + add track');

  // ── 2. Set quantize grid ──────────────────────────────────────
  send(client, { type: 'session_set_quantize', grid: '1/8' });
  const qAck = await waitFor(client, 'quantize_ack');
  assert(qAck.grid === '1/8', 'Quantize grid set to 1/8');
  pass('Set quantize grid → quantize_ack');

  // ── 3. Start recording ────────────────────────────────────────
  send(client, { type: 'record_start' });
  const recStatus1 = await waitFor(client, 'record_status');
  assert(recStatus1.recording === true, 'Recording started');
  assert(recStatus1.eventCount === 0, 'Event count starts at 0');
  pass('Start recording → record_status');

  // ── 4. Play + send notes ──────────────────────────────────────
  send(client, { type: 'transport_play' });
  await waitFor(client, 'transport_ack');

  // Wait a moment for transport to advance
  await new Promise(r => setTimeout(r, 200));

  // Send several notes
  send(client, { type: 'track_note_on', trackId, noteId: 'n1', midi: 60, velocity: 0.8 });
  const ack1 = await waitFor(client, 'track_note_ack');
  assert(ack1.noteId === 'n1', 'Note 1 acked');

  await new Promise(r => setTimeout(r, 150));

  send(client, { type: 'track_note_on', trackId, noteId: 'n2', midi: 64, velocity: 0.7 });
  const ack2 = await waitFor(client, 'track_note_ack');
  assert(ack2.noteId === 'n2', 'Note 2 acked');

  await new Promise(r => setTimeout(r, 150));

  send(client, { type: 'track_note_off', trackId, noteId: 'n1' });
  send(client, { type: 'track_note_off', trackId, noteId: 'n2' });

  await new Promise(r => setTimeout(r, 100));
  pass('Play + send notes → acks received');

  // ── 5. Stop recording ─────────────────────────────────────────
  send(client, { type: 'record_stop' });
  const recStatus2 = await waitFor(client, 'record_status');
  assert(recStatus2.recording === false, 'Recording stopped');
  assert(recStatus2.eventCount > 0, `Event count > 0 (got ${recStatus2.eventCount})`);
  assert(recStatus2.durationSec > 0, `Duration > 0 (got ${recStatus2.durationSec.toFixed(3)}s)`);
  pass(`Stop recording → ${recStatus2.eventCount} events, ${recStatus2.durationSec.toFixed(3)}s`);

  // ── 6. Export recording ───────────────────────────────────────
  send(client, { type: 'transport_stop' });
  await waitFor(client, 'transport_ack');

  send(client, { type: 'record_export', name: 'Test Jam Recording' });
  const exported = await waitFor(client, 'record_exported', 15000);  // longer timeout for offline render
  assert(typeof exported.renderId === 'string' && exported.renderId.length > 0, 'Got renderId');
  assert(exported.durationSec > 0, `Export duration > 0 (got ${exported.durationSec.toFixed(3)}s)`);
  assert(typeof exported.wavHash === 'string' && exported.wavHash.length === 8, 'Got wavHash');
  pass(`Export recording → renderId=${exported.renderId}, ${exported.durationSec.toFixed(3)}s`);

  // ── 7. Verify render exists via REST API ──────────────────────
  const rendersResp = await httpGet('/api/renders');
  const renders = rendersResp.renders;
  assert(Array.isArray(renders), 'Renders API returns array');
  const found = renders.find((r: any) => r.id === exported.renderId);
  assert(found !== undefined, 'Render found in Render Bank');
  assert(found.name === 'Test Jam Recording', 'Render name matches');
  pass('Render exists in Render Bank via REST API');

  // ── 8. Metronome toggle ───────────────────────────────────────
  send(client, { type: 'metronome_toggle' });
  const metroAck = await waitFor(client, 'metronome_ack');
  assert(metroAck.enabled === true, 'Metronome enabled');
  pass('Metronome toggle → metronome_ack { enabled: true }');

  // ── 9. Metronome tick during playback ─────────────────────────
  send(client, { type: 'transport_play' });
  await waitFor(client, 'transport_ack');

  // Collect metronome ticks for ~1.2 seconds (at 120 BPM = 2 beats/sec → ~2 ticks)
  const ticks = await collectMessages(client, 'metronome_tick', 1200);
  assert(ticks.length >= 1, `Got metronome ticks (${ticks.length})`);
  assert(typeof ticks[0].beat === 'number', 'Tick has beat');
  assert(typeof ticks[0].measure === 'number', 'Tick has measure');
  assert(typeof ticks[0].downbeat === 'boolean', 'Tick has downbeat');
  pass(`Metronome ticks received (${ticks.length} ticks in 1.2s)`);

  // Turn off metronome
  send(client, { type: 'metronome_toggle' });
  await waitFor(client, 'metronome_ack');

  // ── 10. Second recording with no quantize ─────────────────────
  send(client, { type: 'session_set_quantize', grid: 'none' });
  await waitFor(client, 'quantize_ack');

  send(client, { type: 'record_start' });
  await waitFor(client, 'record_status');

  await new Promise(r => setTimeout(r, 100));

  send(client, { type: 'track_note_on', trackId, noteId: 'n3', midi: 67, velocity: 0.9 });
  await waitFor(client, 'track_note_ack');

  await new Promise(r => setTimeout(r, 200));

  send(client, { type: 'track_note_off', trackId, noteId: 'n3' });

  await new Promise(r => setTimeout(r, 100));

  send(client, { type: 'record_stop' });
  const recStatus3 = await waitFor(client, 'record_status');
  assert(recStatus3.eventCount >= 2, `Unquantized recording has events (${recStatus3.eventCount})`);

  send(client, { type: 'transport_stop' });
  await waitFor(client, 'transport_ack');

  send(client, { type: 'record_export' });
  const exported2 = await waitFor(client, 'record_exported', 15000);
  assert(exported2.renderId !== exported.renderId, 'Second export has different renderId');
  pass('Second recording + export with no quantize');

  // Cleanup
  client.close();
  await new Promise(r => setTimeout(r, 200));

  console.log(`\n=== ${passed} TESTS PASSED, ${failed} FAILED ===`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('\nTEST FAILED:', err.message);
  process.exit(1);
});
