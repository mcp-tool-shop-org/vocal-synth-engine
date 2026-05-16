/**
 * test-jam-collaboration.ts — Integration test for Phase 5C collaboration + score input.
 *
 * Requires a running server: npx tsx src/server/index.dev.ts
 *
 * Tests:
 *  1. Host + guest connect, hello handshake
 *  2. Host creates session → snapshot has hostId, host has role 'host'
 *  3. Guest joins → role 'guest' in snapshot
 *  4. Host adds track → ownerId matches host's participantId
 *  5. Guest tries track_add → jam_error NOT_HOST
 *  6. Guest tries record_start → jam_error NOT_HOST
 *  7. Guest plays note → track_note_ack (allowed for all)
 *  8. Host starts recording, both play notes → stop → eventCount > 0
 *  9. Host exports → EventTape has participantId on events
 * 10. Host adds score track → score_status
 * 11. Transport play → telemetry shows score track voicesActive > 0
 * 12. Guest tries track_remove on host's track → jam_error NOT_AUTHORIZED
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
  console.log('=== Jam Collaboration Integration Test (Phase 5C) ===\n');

  // ── 1. Host + guest connect ──────────────────────────────────
  const host = await connect('Host');
  const guest = await connect('Guest');

  send(host, { type: 'jam_hello', protocolVersion: 1, displayName: 'Host-Alice' });
  const hostHello = await waitFor(host, 'jam_hello_ack');
  const hostId = hostHello.participantId;
  assert(typeof hostId === 'string', 'Host got participantId');

  send(guest, { type: 'jam_hello', protocolVersion: 1, displayName: 'Guest-Bob' });
  const guestHello = await waitFor(guest, 'jam_hello_ack');
  const guestId = guestHello.participantId;
  assert(typeof guestId === 'string', 'Guest got participantId');
  assert(hostId !== guestId, 'Different participantIds');
  pass('Host + guest connect, hello handshake');

  // ── 2. Host creates session → hostId + role ──────────────────
  send(host, { type: 'session_create', bpm: 120 });
  const created = await waitFor(host, 'session_created');
  const sessionId = created.snapshot.sessionId;
  assert(typeof sessionId === 'string', 'Got sessionId');
  assert(created.snapshot.hostId === hostId, `hostId matches (got ${created.snapshot.hostId})`);

  // Host participant should have role 'host'
  const hostParticipant = created.snapshot.participants.find((p: any) => p.participantId === hostId);
  assert(hostParticipant !== undefined, 'Host found in participants');
  assert(hostParticipant.role === 'host', `Host role is 'host' (got ${hostParticipant.role})`);
  pass('Host creates session → hostId + role=host');

  // ── 3. Guest joins → role 'guest' ────────────────────────────
  // Listen for participant_joined on host side before guest joins
  const pjPromise = waitFor(host, 'participant_joined');
  send(guest, { type: 'session_join', sessionId });
  const joined = await waitFor(guest, 'session_joined');

  assert(joined.snapshot.hostId === hostId, 'Guest snapshot has correct hostId');
  const guestParticipant = joined.snapshot.participants.find((p: any) => p.participantId === guestId);
  assert(guestParticipant !== undefined, 'Guest found in snapshot participants');
  assert(guestParticipant.role === 'guest', `Guest role is 'guest' (got ${guestParticipant.role})`);

  // Host sees participant_joined
  const pj = await pjPromise;
  assert(pj.participant.participantId === guestId, 'Host notified of guest join');
  pass('Guest joins → role=guest in snapshot');

  // ── 4. Host adds track → ownerId ─────────────────────────────
  send(host, { type: 'track_add', presetId: PRESET, name: 'Lead' });
  const trackAdded = await waitFor(host, 'track_added');
  const trackId = trackAdded.track.trackId;
  assert(typeof trackId === 'string', 'Got trackId');
  assert(trackAdded.track.ownerId === hostId, `Track ownerId matches host (got ${trackAdded.track.ownerId})`);
  pass('Host adds track → ownerId matches host');

  // ── 5. Guest tries track_add → NOT_HOST ──────────────────────
  // Drain any pending track_added on guest side first
  await waitFor(guest, 'track_added');

  send(guest, { type: 'track_add', presetId: PRESET, name: 'GuestTrack' });
  const guestAddErr = await waitFor(guest, 'jam_error');
  assert(guestAddErr.code === 'NOT_HOST', `Guest track_add → NOT_HOST (got ${guestAddErr.code})`);
  pass('Guest track_add → jam_error NOT_HOST');

  // ── 6. Guest tries record_start → NOT_HOST ───────────────────
  send(guest, { type: 'record_start' });
  const guestRecErr = await waitFor(guest, 'jam_error');
  assert(guestRecErr.code === 'NOT_HOST', `Guest record_start → NOT_HOST (got ${guestRecErr.code})`);
  pass('Guest record_start → jam_error NOT_HOST');

  // ── 7. Guest plays note → track_note_ack ─────────────────────
  send(host, { type: 'transport_play' });
  await waitFor(host, 'transport_ack');
  await new Promise(r => setTimeout(r, 100));

  send(guest, { type: 'track_note_on', trackId, noteId: 'g1', midi: 60, velocity: 0.8 });
  const guestNoteAck = await waitFor(guest, 'track_note_ack');
  assert(guestNoteAck.noteId === 'g1', 'Guest note acked');
  send(guest, { type: 'track_note_off', trackId, noteId: 'g1' });
  pass('Guest plays note → track_note_ack');

  // ── 8. Host records, both play → eventCount > 0 ──────────────
  send(host, { type: 'record_start' });
  await waitFor(host, 'record_status');

  await new Promise(r => setTimeout(r, 100));

  // Host plays a note
  send(host, { type: 'track_note_on', trackId, noteId: 'h1', midi: 64, velocity: 0.7 });
  await waitFor(host, 'track_note_ack');
  await new Promise(r => setTimeout(r, 100));
  send(host, { type: 'track_note_off', trackId, noteId: 'h1' });

  // Guest plays a note
  send(guest, { type: 'track_note_on', trackId, noteId: 'g2', midi: 67, velocity: 0.9 });
  await waitFor(guest, 'track_note_ack');
  await new Promise(r => setTimeout(r, 100));
  send(guest, { type: 'track_note_off', trackId, noteId: 'g2' });

  await new Promise(r => setTimeout(r, 100));

  send(host, { type: 'record_stop' });
  const recStatus = await waitFor(host, 'record_status');
  assert(recStatus.recording === false, 'Recording stopped');
  assert(recStatus.eventCount >= 4, `Events from both players (got ${recStatus.eventCount})`);
  pass(`Recording with both players → ${recStatus.eventCount} events`);

  // ── 9. Export → EventTape has participantId ───────────────────
  send(host, { type: 'transport_stop' });
  await waitFor(host, 'transport_ack');

  send(host, { type: 'record_export', name: 'Collab Test' });
  const exported = await waitFor(host, 'record_exported', 15000);
  assert(typeof exported.renderId === 'string', 'Got renderId');

  // Verify render exists and check the score.json for participantId
  const rendersResp = await httpGet('/api/renders');
  const renders = rendersResp.renders;
  const render = renders.find((r: any) => r.id === exported.renderId);
  assert(render !== undefined, 'Render found in Render Bank');

  // Check EventTape data via the score endpoint
  const scoreData = await httpGet(`/api/renders/${exported.renderId}/score`);
  assert(scoreData.jam === true, 'Score data has jam flag');
  assert(scoreData.eventTape !== undefined, 'Score data has eventTape');

  const events = scoreData.eventTape.events;
  const hostEvents = events.filter((e: any) => e.participantId === hostId);
  const guestEvents = events.filter((e: any) => e.participantId === guestId);
  assert(hostEvents.length > 0, `Host events attributed (${hostEvents.length})`);
  assert(guestEvents.length > 0, `Guest events attributed (${guestEvents.length})`);
  pass(`Export has participantId attribution (host=${hostEvents.length}, guest=${guestEvents.length})`);

  // ── 10. Host adds score track → score_status ─────────────────
  const testScore = {
    bpm: 120,
    notes: [
      { id: 's1', startSec: 0.0, durationSec: 0.5, midi: 60, velocity: 0.8 },
      { id: 's2', startSec: 0.5, durationSec: 0.5, midi: 64, velocity: 0.7 },
    ],
  };

  send(host, { type: 'track_add', presetId: PRESET, name: 'Score Track', inputMode: 'score' });
  const scoreTrackAdded = await waitFor(host, 'track_added');
  const scoreTrackId = scoreTrackAdded.track.trackId;
  assert(typeof scoreTrackId === 'string', 'Got score trackId');

  send(host, { type: 'track_set_score', trackId: scoreTrackId, score: testScore });
  const scoreStatus = await waitFor(host, 'score_status');
  assert(scoreStatus.trackId === scoreTrackId, 'score_status has correct trackId');
  assert(scoreStatus.noteCount === 2, `score_status noteCount=2 (got ${scoreStatus.noteCount})`);
  assert(scoreStatus.durationSec > 0, `score_status durationSec > 0 (got ${scoreStatus.durationSec})`);
  pass('Score track set → score_status');

  // ── 11. Transport play → telemetry shows score voices ────────
  send(host, { type: 'transport_seek', positionSec: 0 });
  await waitFor(host, 'transport_ack');

  send(host, { type: 'transport_play' });
  await waitFor(host, 'transport_ack');

  // Collect telemetry for ~800ms — score notes start at 0.0s so voices should fire
  const telemetry = await collectMessages(host, 'jam_telemetry', 800);
  assert(telemetry.length >= 1, `Got telemetry messages (${telemetry.length})`);

  // Check if any telemetry shows voices active on the score track
  const scoreTrackTelemetry = telemetry.flatMap((t: any) =>
    t.tracks.filter((tr: any) => tr.trackId === scoreTrackId)
  );
  const anyActive = scoreTrackTelemetry.some((t: any) => t.voicesActive > 0);
  assert(anyActive, 'Score track has active voices during playback');
  pass('Score track voices active during transport play');

  send(host, { type: 'transport_stop' });
  await waitFor(host, 'transport_ack');

  // ── 12. Guest tries track_remove on host's track → NOT_AUTHORIZED ──
  send(guest, { type: 'track_remove', trackId });
  const guestRemoveErr = await waitFor(guest, 'jam_error');
  assert(guestRemoveErr.code === 'NOT_AUTHORIZED', `Guest track_remove → NOT_AUTHORIZED (got ${guestRemoveErr.code})`);
  pass('Guest track_remove on host track → jam_error NOT_AUTHORIZED');

  // Cleanup
  host.close();
  guest.close();
  await new Promise(r => setTimeout(r, 200));

  console.log(`\n=== ${passed} TESTS PASSED, ${failed} FAILED ===`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('\nTEST FAILED:', err.message);
  process.exit(1);
});
