import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';

// This is a mock audio backend to demonstrate the realtime architecture.
// In a real app, this would be replaced by node-rtaudio, portaudio, or Web Audio API.

if (isMainThread) {
  // --- Control / UI Thread ---
  
  async function main() {
    const args = process.argv.slice(2);
    if (args.length < 2) {
      console.error('Usage: npx tsx src/cli/realtime-demo.ts <preset.json> <score.json>');
      process.exit(1);
    }

    const [presetPath, scorePath] = args;
    
    console.log('Starting realtime audio engine...');
    
    const worker = new Worker(new URL(import.meta.url), {
      workerData: {
        presetPath: resolve(presetPath),
        scorePath: resolve(scorePath)
      },
      execArgv: ['--import', 'tsx']
    });
    
    worker.on('message', (msg) => {
      if (msg.type === 'ready') {
        console.log('Audio thread ready. Playing score...');
      } else if (msg.type === 'telemetry') {
        // Process telemetry without blocking audio
        process.stdout.write(`\rRendered block ${msg.blockIndex} | RTF: ${msg.rtf.toFixed(3)}`);
      } else if (msg.type === 'done') {
        console.log('\nPlayback complete.');
        process.exit(0);
      }
    });
    
    worker.on('error', (err) => {
      console.error('\nAudio thread error:', err);
      process.exit(1);
    });
    
    // Simulate sending live score updates
    setTimeout(() => {
      console.log('\n[Control Thread] Sending live score update (adding vibrato)...');
      worker.postMessage({
        type: 'update_score',
        updates: {
          // In a real app, this would be a delta or a new score object
          noteId: 'n1',
          vibrato: { rateHz: 7.0, depthCents: 80, onsetSec: 0.0 }
        }
      });
    }, 1000);
  }
  
  main().catch(console.error);

} else {
  // --- Audio Thread ---
  
  async function runAudioThread() {
    const { loadVoicePreset } = await import('../preset/loader.js');
    const { StreamingVocalSynthEngine } = await import('../engine/StreamingVocalSynthEngine.js');
    
    const { presetPath, scorePath } = workerData;
    
    const preset = await loadVoicePreset(presetPath);
    const scoreContent = await readFile(scorePath, 'utf-8');
    const score = JSON.parse(scoreContent);
    
    const config: any = {
      sampleRateHz: preset.manifest.sampleRateHz,
      blockSize: 512, // Smaller block size for realtime
      presetPath,
      deterministic: "fast",
      rngSeed: Date.now(),
      defaultTimbre: Object.keys(preset.timbres)[0],
      maxPolyphony: 4
    };
    
    const engine = new StreamingVocalSynthEngine(config, preset, score);
    
    parentPort?.postMessage({ type: 'ready' });
    
    // Find total duration
    let maxTimeSec = 0;
    for (const note of score.notes) {
      const endSec = note.startSec + note.durationSec + 0.2;
      if (endSec > maxTimeSec) maxTimeSec = endSec;
    }
    
    const totalBlocks = Math.ceil((maxTimeSec * config.sampleRateHz) / config.blockSize);
    let currentBlock = 0;
    
    // Listen for live updates from control thread
    parentPort?.on('message', (msg) => {
      if (msg.type === 'update_score') {
        // Apply update deterministically at block boundary
        const note = score.notes.find((n: any) => n.id === msg.updates.noteId);
        if (note) {
          note.vibrato = msg.updates.vibrato;
        }
      }
    });
    
    // Mock audio callback loop
    const renderNextBlock = () => {
      if (currentBlock >= totalBlocks) {
        parentPort?.postMessage({ type: 'done' });
        return;
      }
      
      const start = performance.now();
      
      // Render block (no allocations inside the hot loop)
      const block = engine.render(config.blockSize);
      
      const end = performance.now();
      const renderTimeMs = end - start;
      const blockDurationMs = (config.blockSize / config.sampleRateHz) * 1000;
      const rtf = renderTimeMs / blockDurationMs;
      
      // Send telemetry (in a real app, use a lock-free ring buffer, not postMessage per block)
      if (currentBlock % 10 === 0) {
        parentPort?.postMessage({ type: 'telemetry', blockIndex: currentBlock, rtf });
      }
      
      currentBlock++;
      
      // Schedule next block to simulate realtime consumption
      // In a real app, the audio hardware callback drives this loop
      setTimeout(renderNextBlock, blockDurationMs - renderTimeMs);
    };
    
    renderNextBlock();
  }
  
  runAudioThread().catch(err => {
    throw err;
  });
}
