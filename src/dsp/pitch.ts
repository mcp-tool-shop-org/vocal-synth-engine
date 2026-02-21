export function findPitchYin(signal: Float32Array, sampleRate: number): number {
  const half = Math.floor(signal.length / 2);
  const diff = new Float32Array(half);
  
  for (let tau = 0; tau < half; tau++) {
    for (let i = 0; i < half; i++) {
      const d = signal[i] - signal[i + tau];
      diff[tau] += d * d;
    }
  }
  
  const cmndf = new Float32Array(half);
  cmndf[0] = 1;
  let runningSum = 0;
  for (let tau = 1; tau < half; tau++) {
    runningSum += diff[tau];
    cmndf[tau] = diff[tau] * tau / runningSum;
  }
  
  const threshold = 0.1;
  let tauEstimate = -1;
  for (let tau = 2; tau < half; tau++) {
    if (cmndf[tau] < threshold) {
      while (tau + 1 < half && cmndf[tau + 1] < cmndf[tau]) tau++;
      tauEstimate = tau;
      break;
    }
  }
  
  if (tauEstimate === -1) {
    let minVal = Infinity;
    for (let tau = 2; tau < half; tau++) {
      if (cmndf[tau] < minVal) {
        minVal = cmndf[tau];
        tauEstimate = tau;
      }
    }
  }
  
  return sampleRate / tauEstimate;
}
