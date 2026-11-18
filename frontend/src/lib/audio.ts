// Web Audio synthesis for the alert sounds — no external assets, so it works on the GitHub-Pages
// copy and fully offline. Browsers block audio until a user gesture, so unlock() MUST be called from
// within a click handler (the Alerts toggle) before anything will play. Pure sound plumbing; WHEN to
// play is decided by the pure logic in alerts.ts and driven from useAudioAlerts.ts.

type OscType = "sine" | "square" | "triangle" | "sawtooth";

/** One shaped note: frequency (Hz), start offset (s), duration (s), peak gain, waveform. */
export interface Tone {
  freq: number;
  start: number;
  dur: number;
  gain: number;
  type: OscType;
}

/** The WARNING sounds (faults, reflected power). Nothing else may sound like these. */
export const ALERT_TONES: { chime: Tone[]; alarm: Tone[] } = {
  // a two-note rising "attention" chime
  chime: [
    { freq: 660, start: 0, dur: 0.12, gain: 0.16, type: "sine" },
    { freq: 880, start: 0.13, dur: 0.16, gain: 0.16, type: "sine" },
  ],
  // one cycle of the harsh hi-lo fault alarm (repeated every 720 ms)
  alarm: [
    { freq: 880, start: 0, dur: 0.17, gain: 0.3, type: "square" },
    { freq: 620, start: 0.2, dur: 0.17, gain: 0.3, type: "square" },
  ],
};

/** The run clock's REMINDER sounds: soft bell-like triangle tones on a C-major chord (G4/C5/G5),
 * quieter than and at no pitch or waveform the warnings use (2026-11-18: the clock reusing the
 * reflected-power chime scared Matt). Enforced by audio.test.ts. */
export const CLOCK_TONES: { warn: Tone[]; final: Tone[]; over: Tone[] } = {
  // 2 min left: one gentle "ding"
  warn: [{ freq: 784, start: 0, dur: 0.45, gain: 0.1, type: "triangle" }],
  // 30 s left: "ding-ding", rising
  final: [
    { freq: 523.25, start: 0, dur: 0.35, gain: 0.1, type: "triangle" },
    { freq: 784, start: 0.3, dur: 0.45, gain: 0.1, type: "triangle" },
  ],
  // time's up (repeats until dismissed): a doorbell "ding-dong", falling
  over: [
    { freq: 784, start: 0, dur: 0.4, gain: 0.11, type: "triangle" },
    { freq: 392, start: 0.42, dur: 0.6, gain: 0.11, type: "triangle" },
  ],
};

export class AlertAudio {
  private ctx: AudioContext | null = null;
  private alarmTimer: ReturnType<typeof setInterval> | null = null;

  /** Create and/or resume the AudioContext. MUST be called from a user gesture or the browser keeps
   * it suspended. Safe to call repeatedly. */
  unlock(): void {
    if (!this.ctx) {
      const AC =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AC) return;
      this.ctx = new AC();
    }
    if (this.ctx.state === "suspended") void this.ctx.resume();
  }

  /** One shaped beep: attack/release ramps so it never clicks. */
  private beep(freq: number, start: number, dur: number, gain: number, type: OscType): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    const t0 = ctx.currentTime + start;
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(gain, t0 + 0.012);
    g.gain.setValueAtTime(gain, t0 + Math.max(0.02, dur - 0.03));
    g.gain.linearRampToValueAtTime(0, t0 + dur);
    osc.connect(g).connect(ctx.destination);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  }

  /** Play a list of tones once. */
  play(tones: Tone[]): void {
    if (!this.ctx) return;
    for (const t of tones) this.beep(t.freq, t.start, t.dur, t.gain, t.type);
  }

  /** A gentle two-note rising "attention" chime (the reflected-power WARNING), played once. */
  chime(): void {
    this.play(ALERT_TONES.chime);
  }

  /** Start the looping alarm: a harsh hi-lo two-tone repeating until stopAlarm(). Idempotent. */
  startAlarm(): void {
    if (!this.ctx || this.alarmTimer != null) return;
    const cycle = () => this.play(ALERT_TONES.alarm);
    cycle();
    this.alarmTimer = setInterval(cycle, 720);
  }

  stopAlarm(): void {
    if (this.alarmTimer != null) {
      clearInterval(this.alarmTimer);
      this.alarmTimer = null;
    }
  }

  close(): void {
    this.stopAlarm();
    if (this.ctx) {
      void this.ctx.close();
      this.ctx = null;
    }
  }
}
