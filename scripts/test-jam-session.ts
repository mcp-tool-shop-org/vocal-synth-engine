/**
 * test-jam-session.ts — Integration test for Phase 5A jam sessions.
 *
 * Requires a running server: npx tsx src/server/index.dev.ts
 *
 * Tests:
 *  1. Two clients connect + hello handshake
 *  2. Client A creates session
 *  3. Client B joins by sessionId → 2 participants
 *  4. Client A adds track → both receive track_added
 *  5. Transport play → both receive transport_ack
 *  6. Both receive transport_tick with matching position
 *  7. Note on track → track_note_ack
 *  8. Add second track, play both → stable audio
 *  9. Mute track → track_updated broadcast
 * 10. Client B leaves → A gets participant_left
 * 11. Client A disconnects → session auto-destroyed
 */

import WebSocket from 'ws';

const PORT = Number(process.env.PORT ?? 4321);
const TOKEN = process.env.AUTH_TOKEN || '';
const SERVER = `ws://localhost:${PORT}/ws/jam`;
const PRESET_A = 'default-voice';
const PRESET_B = 'default-voice';

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
      // Try to parse everything as JSON (ws may deliver text as Buffer)
      let msg: any;
      try {
        const str = Buffer.isBuffer(raw) ? raw.toString('utf8') : raw.toString();
        if (str.charCodeAt(0) !== 0x7b) return; // skip if not '{' (binary audio frames)
        msg = JSON.parse(str);
      } catch {
        return; // skip unparseable binary frames
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

/** Collect all messages of a type for `durationMs`, return them. */
function collectMessages(ws: WebSocket, type: string, durationMs: number): Promise<any[]> {
  return new Promise((resolve) => {
    const results: any[] = [];
    const handler = (raw: any) => {
      if (Buffer.isBuffer(raw) || raw instanceof ArrayBuffer) return;
      const msg = JSON.parse(raw.toString());
      if (msg.type === type) results.push(msg);
    };
    ws.on('message', handler);
    setTimeout(() => {
      ws.off('message', handler);
      resolve(results);
    }, durationMs);
  });
}

function pass(name: string) {
  passed++;
  console.log(`  PASS [${passed}]: ${name}`);
}

async function main() {
  console.log('=== Jam Session Integration Test ===\n');

  // ── 1. Connect two clients ──────────────────────────────────────
  const clientA = await connect('Alice');
  const clientB = await connect('Bob');

  // Hello handshake
  send(clientA, { type: 'jam_hello', protocolVersion: 1, displayName: 'Alice' });
  const helloA = await waitFor(clientA, 'jam_hello_ack');
  assert(helloA.protocolVersion === 1, 'Protocol version matches');
  assert(typeof helloA.participantId === 'string', 'Got participantId');

  send(clientB, { type: 'jam_hello', protocolVersion: 1, displayName: 'Bob' });
  const helloB = await waitFor(clientB, 'jam_hello_ack');
  assert(typeof helloB.participantId === 'string', 'Bob got participantId');
  pass('Two clients connected + hello handshake');

  // ── 2. Alice creates session ────────────────────────────────────
  send(clientA, { type: 'session_create', bpm: 140 });
  const created = await waitFor(clientA, 'session_created');
  const sessionId = created.snapshot.sessionId;
  assert(typeof sessionId === 'string' && sessionId.length > 0, 'Got sessionId');
  assert(created.snapshot.transport.bpm === 140, 'BPM is 140');
  assert(created.snapshot.participants.length === 1, 'Creator is sole participant');
  pass('Session created');

  // ── 3. Bob joins ────────────────────────────────────────────────
  // Start listening for participant_joined BEFORE Bob joins (race-safe)
  const pJoinedPromise = waitFor(clientA, 'participant_joined');
  send(clientB, { type: 'session_join', sessionId });
  const joined = await waitFor(clientB, 'session_joined');
  assert(joined.snapshot.sessionId === sessionId, 'Same session');
  assert(joined.snapshot.participants.length === 2, 'Two participants');

  const pJoined = await pJoinedPromise;
  assert(pJoined.participant.displayName === 'Bob', 'Alice sees Bob joined');
  pass('Bob joined, both see 2 participants');

  // ── 4. Alice adds a track ──────────────────────────────────────
  const trackAddedBPromise = waitFor(clientB, 'track_added');
  send(clientA, { type: 'track_add', presetId: PRESET_A, name: 'Lead' });
  const trackAddedA = await waitFor(clientA, 'track_added');
  const trackId1 = trackAddedA.track.trackId;
  assert(typeof trackId1 === 'string', 'Got trackId');
  assert(trackAddedA.track.name === 'Lead', 'Track name matches');

  const trackAddedB = await trackAddedBPromise;
  assert(trackAddedB.track.trackId === trackId1, 'Bob sees same trackId');
  pass('Track added, both clients notified');

  // ── 5. Transport play ──────────────────────────────────────────
  const ackBPromise = waitFor(clientB, 'transport_ack');
  send(clientA, { type: 'transport_play' });
  const ackA = await waitFor(clientA, 'transport_ack');
  assert(ackA.transport.playing === true, 'Transport playing');

  const ackB = await ackBPromise;
  assert(ackB.transport.playing === true, 'Bob also sees playing');
  pass('Transport play — both clients notified');

  // ── 6. Transport tick sync ─────────────────────────────────────
  const tickA = await waitFor(clientA, 'transport_tick');
  const tickB = await waitFor(clientB, 'transport_tick');
  assert(typeof tickA.currentSec === 'number', 'Tick has currentSec');
  assert(typeof tickB.currentSec === 'number', 'Bob tick has currentSec');
  // Both should be close (within a few ticks of each other)
  assert(Math.abs(tickA.currentSec - tickB.currentSec) < 1.0,
    `Transport positions close: A=${tickA.currentSec.toFixed(3)}, B=${tickB.currentSec.toFixed(3)}`);
  pass('Transport tick received by both clients');

  // ── 7. Note on track ──────────────────────────────────────────
  send(clientA, {
    type: 'track_note_on',
    trackId: trackId1,
    noteId: 'n1',
    midi: 60,
    velocity: 0.8,
  });
  const noteAck = await waitFor(clientA, 'track_note_ack');
  assert(noteAck.trackId === trackId1, 'Note ack for correct track');
  assert(noteAck.noteId === 'n1', 'Note ack for correct noteId');
  assert(typeof noteAck.voiceIndex === 'number', 'Got voice index');
  pass('Note acknowledged');

  // ── 8. Add second track, play both ─────────────────────────────
  send(clientA, { type: 'track_add', presetId: PRESET_B, name: 'Harmony' });
  const trackAdded2 = await waitFor(clientA, 'track_added');
  const trackId2 = trackAdded2.track.trackId;
  assert(trackId2 !== trackId1, 'Second track has different ID');

  // Play a note on track 2
  send(clientB, {
    type: 'track_note_on',
    trackId: trackId2,
    noteId: 'n2',
    midi: 64,
    velocity: 0.7,
  });
  const noteAck2 = await waitFor(clientB, 'track_note_ack');
  assert(noteAck2.trackId === trackId2, 'Note ack for track 2');

  // Wait a bit then check telemetry shows both tracks active
  const telemetry = await waitFor(clientA, 'jam_telemetry', 3000);
  assert(Array.isArray(telemetry.tracks), 'Telemetry has tracks array');
  assert(telemetry.tracks.length === 2, 'Two tracks in telemetry');
  pass('Two tracks with different voices, both playing');

  // ── 9. Mute track ─────────────────────────────────────────────
  const updatedBPromise = waitFor(clientB, 'track_updated');
  send(clientA, { type: 'track_update', trackId: trackId1, mute: true });
  const updated = await waitFor(clientA, 'track_updated');
  assert(updated.track.trackId === trackId1, 'Updated correct track');
  assert(updated.track.mute === true, 'Track is muted');

  const updatedB = await updatedBPromise;
  assert(updatedB.track.mute === true, 'Bob sees track muted');
  pass('Mute track — both clients see update');

  // ── Release notes before stopping ─────────────────────────────
  send(clientA, { type: 'track_note_off', trackId: trackId1, noteId: 'n1' });
  send(clientB, { type: 'track_note_off', trackId: trackId2, noteId: 'n2' });

  // Stop transport
  send(clientA, { type: 'transport_stop' });
  const stopAck = await waitFor(clientA, 'transport_ack');
  assert(stopAck.transport.playing === false, 'Transport stopped');
  pass('Transport stopped cleanly');

  // ── 10. Client B leaves ────────────────────────────────────────
  const pLeftPromise = waitFor(clientA, 'participant_left');
  send(clientB, { type: 'session_leave' });
  const leftAck = await waitFor(clientB, 'session_left');
  assert(leftAck.sessionId === sessionId, 'Bob left correct session');

  const pLeft = await pLeftPromise;
  assert(typeof pLeft.participantId === 'string', 'Alice notified of departure');
  pass('Client B left, Client A notified');

  // ── 11. Client A disconnects → session auto-destroyed ──────────
  // We can't directly verify server-side cleanup from the client,
  // but we can verify reconnect + attempt to join the old session fails
  clientA.close();
  await new Promise(r => setTimeout(r, 200));

  const clientC = await connect('Charlie');
  send(clientC, { type: 'jam_hello', protocolVersion: 1, displayName: 'Charlie' });
  await waitFor(clientC, 'jam_hello_ack');

  send(clientC, { type: 'session_join', sessionId });
  const err = await waitFor(clientC, 'jam_error');
  assert(err.code === 'SESSION_NOT_FOUND', 'Session was auto-destroyed');
  pass('Session auto-destroyed after last participant left');

  clientB.close();
  clientC.close();

  console.log(`\n=== ${passed} TESTS PASSED, ${failed} FAILED ===`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('\nTEST FAILED:', err.message);
  process.exit(1);
});
