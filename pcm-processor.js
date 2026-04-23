// AudioWorklet processor — runs on the dedicated audio rendering thread.
// Accumulates 128-sample render quanta into BUFFER_FRAMES-sized chunks,
// then transfers the buffer (zero-copy) to the main thread via MessagePort.

const BUFFER_FRAMES = 4096; // ~256 ms at 16 kHz

class PCMProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buf = new Float32Array(BUFFER_FRAMES);
    this._filled = 0;
  }

  process(inputs) {
    const channel = inputs[0]?.[0];
    if (!channel) return true;

    let offset = 0;
    while (offset < channel.length) {
      const toCopy = Math.min(channel.length - offset, BUFFER_FRAMES - this._filled);
      this._buf.set(channel.subarray(offset, offset + toCopy), this._filled);
      this._filled += toCopy;
      offset += toCopy;

      if (this._filled === BUFFER_FRAMES) {
        this.port.postMessage(this._buf, [this._buf.buffer]);
        this._buf = new Float32Array(BUFFER_FRAMES);
        this._filled = 0;
      }
    }

    return true; // keep processor alive between chunks
  }
}

registerProcessor('pcm-processor', PCMProcessor);
