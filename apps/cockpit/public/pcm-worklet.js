/**
 * PCM Ring Buffer AudioWorklet Processor
 *
 * Receives Float32 PCM blocks from the main thread via port.postMessage,
 * queues them in a ring buffer, and outputs them at audio rate.
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

    this.port.onmessage = (e) => {
      if (e.data instanceof Float32Array) {
        this.enqueue(e.data);
      } else if (e.data.type === 'reset') {
        this.writePos = 0;
        this.readPos = 0;
        this.samplesAvailable = 0;
        this.underruns = 0;
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
  }

  process(inputs, outputs) {
    const output = outputs[0];
    if (!output || output.length === 0) return true;

    const channel = output[0];
    const len = channel.length; // typically 128 samples

    if (this.samplesAvailable >= len) {
      for (let i = 0; i < len; i++) {
        channel[i] = this.buffer[this.readPos];
        this.readPos = (this.readPos + 1) % this.bufferSize;
      }
      this.samplesAvailable -= len;
    } else {
      // Underrun: output silence
      channel.fill(0);
      this.underruns++;

      // Report underruns periodically (every 100 underruns)
      if (this.underruns % 100 === 0) {
        this.port.postMessage({ type: 'underrun', count: this.underruns });
      }
    }

    return true;
  }
}

registerProcessor('pcm-worklet-processor', PcmWorkletProcessor);
