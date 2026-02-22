/**
 * PCM Ring Buffer AudioWorklet Processor
 *
 * Receives Float32 PCM blocks from the main thread via port.postMessage,
 * queues them in a ring buffer, and outputs them at audio rate.
 *
 * Supports a "target fill" level: won't start outputting audio until
 * the buffer has accumulated at least targetSamples. This trades
 * initial latency for underrun resistance.
 */
class PcmWorkletProcessor extends AudioWorkletProcessor {
  constructor() {
    super();

    // Ring buffer: ~2 seconds at 48kHz = 96000 samples
    this.bufferSize = 96000;
    this.buffer = new Float32Array(this.bufferSize);
    this.writePos = 0;
    this.readPos = 0;
    this.samplesAvailable = 0;
    this.underruns = 0;

    // Target fill: buffer this many samples before starting playback
    // Default ~100ms at 48kHz = 4800 samples
    this.targetSamples = 4800;
    this.primed = false; // true once initial target reached

    this.port.onmessage = (e) => {
      if (e.data instanceof Float32Array) {
        this.enqueue(e.data);
      } else if (e.data.type === 'reset') {
        this.writePos = 0;
        this.readPos = 0;
        this.samplesAvailable = 0;
        this.underruns = 0;
        this.primed = false;
      } else if (e.data.type === 'setTargetBuffer') {
        this.targetSamples = e.data.samples;
        // Re-prime if we drop below new target
        if (this.samplesAvailable < this.targetSamples) {
          this.primed = false;
        }
      }
    };
  }

  enqueue(samples) {
    for (let i = 0; i < samples.length; i++) {
      this.buffer[this.writePos] = samples[i];
      this.writePos = (this.writePos + 1) % this.bufferSize;
    }
    this.samplesAvailable += samples.length;
    if (this.samplesAvailable > this.bufferSize) {
      // Overflow: drop oldest samples
      const overflow = this.samplesAvailable - this.bufferSize;
      this.readPos = (this.readPos + overflow) % this.bufferSize;
      this.samplesAvailable = this.bufferSize;
    }

    // Check if we've reached the target fill level
    if (!this.primed && this.samplesAvailable >= this.targetSamples) {
      this.primed = true;
    }
  }

  process(inputs, outputs) {
    const output = outputs[0];
    if (!output || output.length === 0) return true;

    const channel = output[0];
    const len = channel.length; // typically 128 samples

    // Don't output until primed (initial buffer fill reached)
    if (!this.primed) {
      channel.fill(0);
      return true;
    }

    if (this.samplesAvailable >= len) {
      for (let i = 0; i < len; i++) {
        channel[i] = this.buffer[this.readPos];
        this.readPos = (this.readPos + 1) % this.bufferSize;
      }
      this.samplesAvailable -= len;
    } else {
      // Underrun: output silence, re-prime
      channel.fill(0);
      this.underruns++;
      this.primed = false;

      // Report every underrun
      this.port.postMessage({ type: 'underrun', count: this.underruns });
    }

    return true;
  }
}

registerProcessor('pcm-worklet-processor', PcmWorkletProcessor);
