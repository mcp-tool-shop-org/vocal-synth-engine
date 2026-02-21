export function fft(real: Float32Array, imag: Float32Array) {
  const n = real.length;
  if ((n & (n - 1)) !== 0) throw new Error("FFT length must be power of 2");
  
  let j = 0;
  for (let i = 0; i < n - 1; i++) {
    if (i < j) {
      let tr = real[i], ti = imag[i];
      real[i] = real[j]; imag[i] = imag[j];
      real[j] = tr; imag[j] = ti;
    }
    let m = n >> 1;
    while (j >= m) { j -= m; m >>= 1; }
    j += m;
  }
  
  for (let size = 2; size <= n; size <<= 1) {
    const halfSize = size >> 1;
    const angle = -2 * Math.PI / size;
    const wStepR = Math.cos(angle);
    const wStepI = Math.sin(angle);
    for (let i = 0; i < n; i += size) {
      let wr = 1, wi = 0;
      for (let j = i; j < i + halfSize; j++) {
        const k = j + halfSize;
        const tr = wr * real[k] - wi * imag[k];
        const ti = wr * imag[k] + wi * real[k];
        real[k] = real[j] - tr;
        imag[k] = imag[j] - ti;
        real[j] += tr;
        imag[j] += ti;
        const nextWr = wr * wStepR - wi * wStepI;
        const nextWi = wr * wStepI + wi * wStepR;
        wr = nextWr; wi = nextWi;
      }
    }
  }
}

export function ifft(real: Float32Array, imag: Float32Array) {
  const n = real.length;
  for (let i = 0; i < n; i++) imag[i] = -imag[i];
  fft(real, imag);
  for (let i = 0; i < n; i++) {
    real[i] /= n;
    imag[i] = -imag[i] / n;
  }
}

export function applyHannWindow(buffer: Float32Array) {
  const n = buffer.length;
  for (let i = 0; i < n; i++) {
    buffer[i] *= 0.5 * (1 - Math.cos((2 * Math.PI * i) / (n - 1)));
  }
}
