#!/usr/bin/env python3
"""
Generate vowel calibration WAVs from a Kokoro TTS voice.

Usage:
    py -3.14 scripts/kokoro/generate_vowels.py --voice af_heart --out calib/af_heart
    py -3.14 scripts/kokoro/generate_vowels.py --voice am_fenrir --out calib/am_fenrir --speed 0.6

Produces AH.wav, EE.wav, OO.wav (48kHz mono, -3 dBFS, 3s each)
plus calib_report.json with F0 stats per vowel.

Requires: py -3.14 (kokoro_onnx + onnxruntime + soundfile + scipy + numpy)
"""

import argparse
import json
import os
import sys
import time

import numpy as np
import onnxruntime as rt
import soundfile as sf
from scipy.signal import resample_poly

# Kokoro tokenizer (handles phonemization + token encoding)
from kokoro_onnx import Tokenizer

# ---------- constants ----------
KOKORO_SR = 24000        # Kokoro output sample rate
TARGET_SR = 48000        # Engine expects 48kHz
TARGET_DURATION = 3.0    # seconds per vowel WAV
PEAK_DBFS = -3.0         # normalize to this peak level
FADE_MS = 10             # fade in/out to avoid edge clicks

# Vowel-rich sentence prompts. Kokoro produces natural speech, not sustained
# tones — we use sentences heavy in the target vowel and extract the best
# voiced window via YIN F0 analysis. Multiple sentences for each vowel give
# the extractor more material to choose from.
VOWEL_PROMPTS = {
    "AH": (
        "The father called from afar across the calm dark garden. "
        "His heart was large and his arms were sharp and strong. "
        "The stars are bright above the barn on father's farm."
    ),
    "EE": (
        "She could see the green field clearly in her dream. "
        "The breeze was easy and the trees leaned peacefully. "
        "We believe in freedom and keeping the streets clean and free."
    ),
    "OO": (
        "The moon shone through the cool smooth pool of blue. "
        "She knew the truth would bloom soon in the room. "
        "A spoon was used to scoop the food into the groove."
    ),
}

# ---------- YIN pitch detector ----------
def yin_f0(signal: np.ndarray, sr: int, frame_size: int = 2048, hop: int = 512,
           threshold: float = 0.15) -> tuple[np.ndarray, np.ndarray]:
    """
    Simple YIN F0 estimator. Returns (f0_hz, confidence) arrays.
    confidence = 1 - CMNDF minimum (higher = more periodic).
    """
    n_frames = max(1, (len(signal) - frame_size) // hop + 1)
    f0 = np.zeros(n_frames)
    confidence = np.zeros(n_frames)
    tau_max = frame_size // 2

    for i in range(n_frames):
        start = i * hop
        frame = signal[start:start + frame_size].astype(np.float64)
        if len(frame) < frame_size:
            break

        # Step 1: difference function
        d = np.zeros(tau_max)
        for tau in range(1, tau_max):
            diff = frame[:tau_max] - frame[tau:tau + tau_max]
            d[tau] = np.sum(diff * diff)

        # Step 2: cumulative mean normalized difference (CMNDF)
        cmndf = np.ones(tau_max)
        running_sum = 0.0
        for tau in range(1, tau_max):
            running_sum += d[tau]
            if running_sum > 0:
                cmndf[tau] = d[tau] * tau / running_sum
            else:
                cmndf[tau] = 1.0

        # Step 3: absolute threshold
        best_tau = 0
        for tau in range(2, tau_max):
            if cmndf[tau] < threshold:
                # Parabolic interpolation for sub-sample accuracy
                if tau > 0 and tau < tau_max - 1:
                    s0 = cmndf[tau - 1]
                    s1 = cmndf[tau]
                    s2 = cmndf[tau + 1]
                    denom = s0 - 2 * s1 + s2
                    adj = 0.5 * (s0 - s2) / denom if denom != 0 else 0
                    best_tau = tau + adj
                else:
                    best_tau = tau
                break

        if best_tau > 0:
            f0[i] = sr / best_tau
            conf_idx = min(max(int(round(best_tau)), 0), tau_max - 1)
            confidence[i] = 1.0 - cmndf[conf_idx]
        else:
            # Fallback: find global CMNDF minimum
            min_tau = np.argmin(cmndf[2:]) + 2
            f0[i] = sr / min_tau
            confidence[i] = 1.0 - cmndf[min_tau]

    return f0, confidence


def find_stable_region(signal: np.ndarray, sr: int, min_dur: float = 0.3) -> tuple[int, int, float]:
    """
    Find the most stable voiced region in the signal.
    Returns (start_sample, end_sample, median_f0) of the best window.

    Searches for the longest continuously voiced region with stable F0,
    requiring at least min_dur seconds. The build-preset pipeline only
    needs a single FFT frame (~42ms), so even short regions work.
    """
    frame_size = 2048
    hop = 512
    f0, conf = yin_f0(signal, sr, frame_size, hop)

    # Find runs of voiced frames (conf > 0.4)
    voiced = conf > 0.4
    runs: list[tuple[int, int]] = []
    in_run = False
    run_start = 0
    for i in range(len(voiced)):
        if voiced[i] and not in_run:
            run_start = i
            in_run = True
        elif not voiced[i] and in_run:
            runs.append((run_start, i))
            in_run = False
    if in_run:
        runs.append((run_start, len(voiced)))

    min_frames = max(1, int(min_dur * sr / hop))

    best_score = -1.0
    best_run = (0, min(len(f0), min_frames))
    best_f0 = 200.0

    for start_f, end_f in runs:
        length = end_f - start_f
        if length < min_frames:
            continue

        region_f0 = f0[start_f:end_f]
        region_conf = conf[start_f:end_f]

        # Filter out obviously wrong F0 values (< 50 Hz or > 500 Hz for speech)
        valid = (region_f0 > 50) & (region_f0 < 500)
        valid_f0 = region_f0[valid]
        if len(valid_f0) < 3:
            continue

        median = float(np.median(valid_f0))
        std = float(np.std(valid_f0))
        cv = std / max(median, 1.0)
        stability = max(0, 1.0 - cv * 5)

        # Score: longer runs + more stable F0 + higher confidence
        score = length * stability * float(np.mean(region_conf))

        if score > best_score:
            best_score = score
            best_run = (start_f, end_f)
            best_f0 = median

    start_sample = best_run[0] * hop
    end_sample = min(best_run[1] * hop + frame_size, len(signal))

    return start_sample, end_sample, best_f0


def generate_vowel(sess: rt.InferenceSession, tokenizer: Tokenizer,
                   voice_data: np.ndarray, vowel: str, prompt: str,
                   speed: float) -> np.ndarray:
    """Generate a single vowel WAV from Kokoro, return 48kHz float32 mono."""
    print(f"  Generating {vowel}...")

    # Phonemize + tokenize
    phonemes = tokenizer.phonemize(prompt, "en-us")
    tokens = tokenizer.tokenize(phonemes)
    print(f"    Tokens: {len(tokens)}")

    # Style vector: index by token count, clamp to 509
    style_idx = min(len(tokens), 509)
    style = voice_data[style_idx].reshape(1, 256).astype(np.float32)

    # Build input tensors
    tokens_arr = np.array([[0, *tokens, 0]], dtype=np.int64)

    # Detect model input key name (v1.0 uses 'input_ids')
    input_names = [inp.name for inp in sess.get_inputs()]
    token_key = "input_ids" if "input_ids" in input_names else "tokens"

    inputs = {
        token_key: tokens_arr,
        "style": style,
        "speed": np.array([speed], dtype=np.float32),
    }

    # Run inference
    t0 = time.time()
    result = sess.run(None, inputs)
    elapsed = time.time() - t0
    audio_24k = result[0].flatten().astype(np.float32)
    print(f"    Kokoro: {len(audio_24k)/KOKORO_SR:.2f}s audio in {elapsed:.2f}s")

    if len(audio_24k) < KOKORO_SR * 0.3:
        raise RuntimeError(f"Kokoro produced too little audio ({len(audio_24k)} samples). "
                           "Try a longer prompt or different speed.")

    # Find best stable voiced region at 24kHz
    start, end, median_f0 = find_stable_region(audio_24k, KOKORO_SR)
    region = audio_24k[start:end]
    region_dur = len(region) / KOKORO_SR
    print(f"    Stable region: {start/KOKORO_SR:.3f}s - {end/KOKORO_SR:.3f}s "
          f"({region_dur:.2f}s, F0≈{median_f0:.0f}Hz)")

    # Compute F0 stats on the 24kHz region (YIN works best at native SR)
    f0_stats = compute_f0_stats(region, KOKORO_SR)

    # Resample 24kHz → 48kHz (factor 2)
    region_48k = resample_poly(region, up=2, down=1).astype(np.float32)

    # Build output by repeating the voiced region to fill TARGET_DURATION.
    # The build-preset pipeline takes an FFT frame from the file center,
    # so we must ensure voiced audio at every position.
    target_samples = int(TARGET_DURATION * TARGET_SR)

    if len(region_48k) >= target_samples:
        # Trim from center
        trim_start = (len(region_48k) - target_samples) // 2
        audio_48k = region_48k[trim_start:trim_start + target_samples].copy()
    else:
        # Loop with proper overlap-add cross-fade at seams.
        # Strategy: tile enough copies, then cross-fade at each boundary.
        xfade = min(int(0.010 * TARGET_SR), len(region_48k) // 4)  # 10ms cross-fade
        stride = len(region_48k) - xfade  # effective advance per tile
        n_tiles = (target_samples // stride) + 2  # enough to overshoot

        # Build cross-fadeable region: fade out last xfade samples,
        # fade in first xfade samples
        fade_in = np.linspace(0, 1, xfade, dtype=np.float32)
        fade_out = np.linspace(1, 0, xfade, dtype=np.float32)

        total_len = stride * n_tiles + xfade
        audio_48k = np.zeros(total_len, dtype=np.float32)

        for t in range(n_tiles):
            pos = t * stride
            end = pos + len(region_48k)
            if end > total_len:
                break
            chunk = region_48k.copy()
            if t > 0:
                # Fade in the start of this tile
                chunk[:xfade] *= fade_in
            if t < n_tiles - 1:
                # Fade out the end of this tile
                chunk[-xfade:] *= fade_out
            audio_48k[pos:end] += chunk

        audio_48k = audio_48k[:target_samples]

    # Normalize to peak dBFS
    peak = np.max(np.abs(audio_48k))
    if peak > 0:
        target_peak = 10 ** (PEAK_DBFS / 20)  # -3 dBFS ≈ 0.708
        audio_48k *= target_peak / peak

    # Fade in/out
    fade_samples = int(FADE_MS / 1000 * TARGET_SR)
    fade_in = np.linspace(0, 1, fade_samples, dtype=np.float32)
    fade_out = np.linspace(1, 0, fade_samples, dtype=np.float32)
    audio_48k[:fade_samples] *= fade_in
    audio_48k[-fade_samples:] *= fade_out

    return audio_48k, f0_stats


def compute_f0_stats(audio: np.ndarray, sr: int) -> dict:
    """Compute F0 statistics for a vowel signal. Filters unreasonable values."""
    f0, conf = yin_f0(audio, sr)
    # Only count voiced + plausible speech F0 range
    valid = (conf > 0.4) & (f0 > 50) & (f0 < 500)
    valid_f0 = f0[valid]
    voiced_mask = conf > 0.4

    if len(valid_f0) == 0:
        return {"f0_mean": 0, "f0_std": 0, "f0_min": 0, "f0_max": 0,
                "voiced_ratio": 0, "confidence_mean": 0}

    return {
        "f0_mean": round(float(np.mean(valid_f0)), 2),
        "f0_std": round(float(np.std(valid_f0)), 2),
        "f0_min": round(float(np.min(valid_f0)), 2),
        "f0_max": round(float(np.max(valid_f0)), 2),
        "voiced_ratio": round(float(np.mean(voiced_mask)), 3),
        "confidence_mean": round(float(np.mean(conf[valid])), 3),
    }


def main():
    parser = argparse.ArgumentParser(description="Generate vowel calibration WAVs from Kokoro TTS")
    parser.add_argument("--voice", required=True, help="Kokoro voice ID (e.g. af_heart, am_fenrir)")
    parser.add_argument("--out", required=True, help="Output directory for WAVs")
    parser.add_argument("--speed", type=float, default=0.7, help="Kokoro speed (default 0.7, slower = longer)")
    parser.add_argument("--model", default=None, help="Path to kokoro.onnx model")
    parser.add_argument("--voices-npz", default=None, help="Path to voices.npz")
    args = parser.parse_args()

    # Resolve paths
    script_dir = os.path.dirname(os.path.abspath(__file__))
    project_root = os.path.abspath(os.path.join(script_dir, "..", ".."))
    model_path = args.model or os.path.join(project_root, "models", "kokoro.onnx")
    voices_path = args.voices_npz or os.path.join(project_root, "models", "voices.npz")
    out_dir = os.path.abspath(args.out)

    # Validate
    if not os.path.exists(model_path):
        print(f"Model not found: {model_path}", file=sys.stderr)
        sys.exit(1)
    if not os.path.exists(voices_path):
        print(f"Voices not found: {voices_path}", file=sys.stderr)
        sys.exit(1)

    # Load voice
    voices = np.load(voices_path)
    if args.voice not in voices:
        available = ", ".join(voices.keys())
        print(f"Voice '{args.voice}' not found. Available: {available}", file=sys.stderr)
        sys.exit(1)
    voice_data = voices[args.voice]
    print(f"Voice: {args.voice} (style shape: {voice_data.shape})")

    # Load ONNX model
    print(f"Loading model: {model_path}")
    sess = rt.InferenceSession(model_path, providers=["CPUExecutionProvider"])
    tokenizer = Tokenizer()

    os.makedirs(out_dir, exist_ok=True)

    # Generate each vowel
    report = {
        "voice": args.voice,
        "speed": args.speed,
        "target_sr": TARGET_SR,
        "target_duration": TARGET_DURATION,
        "peak_dbfs": PEAK_DBFS,
        "vowels": {},
    }

    for vowel, prompt in VOWEL_PROMPTS.items():
        audio, stats = generate_vowel(sess, tokenizer, voice_data, vowel, prompt, args.speed)

        # Write WAV
        wav_path = os.path.join(out_dir, f"{vowel}.wav")
        sf.write(wav_path, audio, TARGET_SR, subtype="FLOAT")
        print(f"    Wrote: {wav_path} ({len(audio)/TARGET_SR:.1f}s, {TARGET_SR}Hz)")

        report["vowels"][vowel] = {
            "samples": len(audio),
            "duration_sec": round(len(audio) / TARGET_SR, 3),
            "peak_dbfs": PEAK_DBFS,
            **stats,
        }
        print(f"    F0: {stats['f0_mean']:.1f} Hz (std={stats['f0_std']:.1f}), "
              f"voiced={stats['voiced_ratio']:.1%}")

    # Write calibration report
    report_path = os.path.join(out_dir, "calib_report.json")
    with open(report_path, "w") as f:
        json.dump(report, f, indent=2)
    print(f"\nCalibration report: {report_path}")
    print("Done.")


if __name__ == "__main__":
    main()
