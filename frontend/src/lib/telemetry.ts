// Telemetry types (mirror of the backend snapshot JSON) + a small ring buffer for plots.

export interface Telemetry {
  host_timestamp_ns: number;
  forward_w: number;
  reverse_w: number;
  load_w: number;
  reflected_fraction: number;
  rf_on: boolean;
  temperature_c: number;
  operation_mode: string;
  tuner: string;
  status: number;
  // Matching-network / generator readback (optional: older operators may omit these).
  manual_mode?: boolean;
  tune_cap_percent?: number;
  load_cap_percent?: number;
  dc_voltage?: number;
  preset_slot?: number;
}

export interface Limits {
  max_forward_w: number;
  max_reflected_w: number;
  temperature_c_trip: number;
  reflected_fraction_warn: number;
}

export interface SafetyLimitsForm {
  max_forward_w: number;
  max_reflected_w: number;
  temperature_c_trip: number;
}

export interface SafetyLimitsStatus extends SafetyLimitsForm {
  bounds: Record<string, [number, number]>;
}

export interface Snapshot {
  state: "disconnected" | "connected" | "fault" | "closed";
  fault_reasons: string[];
  warnings: string[];
  telemetry: Telemetry | null;
  limits: Limits;
}

export interface DeviceInfo {
  id?: string;
  serial?: string;
  firmware?: { ui: string; rf: string };
  frequency_hz?: number;
  power_limit_w?: number;
}

/** Live state of the in-situ thermal closed loop (top-level `thermal` block of the snapshot). */
export interface ThermalStatus {
  running: boolean;
  phase: "ramp" | "approach" | "soak" | "cool" | "done";
  mode: string;
  armed: boolean;
  source: string;
  control_temp_c: number;
  target_c: number;
  recommended_w: number;
  applied_w: number | null;
}

/** Editable thermal plan (bounds-clamped server-side). */
export interface ThermalPlanForm {
  target_c: number;
  soak_s: number;
  approach_band_c: number;
  loop_ceiling_w: number;
  max_step_w: number;
  done_below_c: number;
}

export interface ThermalPlanStatus extends ThermalPlanForm {
  bounds: Record<string, [number, number]>;
}

/** Live state of the software power ramp (init -> target at W/s). */
export interface RampStatus {
  running: boolean;
  done: boolean;
  output_w: number;
  init_w: number;
  target_w: number;
  rate_w_per_s: number;
}

export interface RampForm {
  init_w: number;
  target_w: number;
  rate_w_per_s: number;
}

export interface RampConfig extends RampForm {
  bounds: Record<string, [number, number]>;
}

/** Live state of the auto-shutoff timer (N minutes -> RF off). */
export interface TimerStatus {
  running: boolean;
  done: boolean;
  minutes: number;
  elapsed_s: number;
  remaining_s: number;
}

export interface TimerConfig {
  minutes: number;
  bounds: Record<string, [number, number]>;
}

/** One software tuner-cap preset slot. */
export interface PresetSlot {
  tune_cap_percent: number;
  load_cap_percent: number;
}

export interface PresetsStatus {
  slots: Record<string, PresetSlot | null>;
  num_slots: number;
}

/** Live state of the simulator-first PULSE (setpoint gated on/off). */
export interface PulseStatus {
  running: boolean;
  on_ms: number;
  off_ms: number;
  power_w: number;
  duty: number;
  output_on: boolean;
}

export interface PulseConfig {
  on_ms: number;
  off_ms: number;
  power_w: number;
  bounds: Record<string, [number, number]>;
}

/** One perturb-and-observe move the tuner made (or would make). */
export interface MatchTunerMove {
  axis: "tune" | "load";
  delta: number;
}

/** Live state of the software matching auto-tuner (top-level `match_tuner` block). */
export interface MatchTunerStatus {
  running: boolean;
  armed: boolean;
  phase: "idle" | "searching" | "holding";
  mode: string;
  reverse_fraction: number | null;
  best: number | null;
  last_move: MatchTunerMove | null;
  recommended: { tune: number; load: number } | null;
}

/** Editable match-tuner config (bounds-clamped server-side). */
export interface MatchTunerForm {
  mode: string;
  tune_step: number;
  load_step: number;
  guard: number;
}

export interface MatchTunerConfig extends MatchTunerForm {
  bounds: Record<string, [number, number]>;
}

export interface Status {
  device: DeviceInfo;
  controller: Snapshot;
  recording: { active: boolean; run: string | null };
  thermal: ThermalStatus;
  ramp: RampStatus;
  timer: TimerStatus;
  presets: PresetsStatus;
  pulse: PulseStatus;
  match_tuner: MatchTunerStatus;
}

export interface Point {
  t: number;
  v: number;
}

/** Fixed-capacity ring buffer keeping the most recent N points in insertion order. */
export class TraceBuffer {
  private readonly capacity: number;
  private points: Point[] = [];

  constructor(capacity: number) {
    this.capacity = capacity;
  }

  push(t: number, v: number): void {
    this.points.push({ t, v });
    if (this.points.length > this.capacity) {
      this.points.shift();
    }
  }

  toArray(): Point[] {
    return [...this.points];
  }
}
