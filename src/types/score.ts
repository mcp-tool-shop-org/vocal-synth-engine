export type TimbreId = string;

export interface VocalNote {
  id: string;
  startSec: number;
  durationSec: number;
  midi: number;           // pitch target
  velocity?: number;      // 0..1 maps to amplitude
  timbre?: TimbreId;      // default if omitted
  vibrato?: { rateHz: number; depthCents: number; onsetSec: number };
  portamentoSec?: number; // glide into this note
}

export interface AutomationPoint {
  tSec: number;
  value: number;          // normalized unless otherwise specified
}

export interface VocalScore {
  bpm: number;
  notes: VocalNote[];
  lanes?: {
    dynamics?: AutomationPoint[];      // 0..1
    breathiness?: AutomationPoint[];   // 0..1
    timbreMorph?: Record<TimbreId, AutomationPoint[]>; // weights
  };
}
