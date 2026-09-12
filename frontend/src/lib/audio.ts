// Web Audio synthesis for the alert sounds — no external assets, so it works on the GitHub-Pages
// copy and fully offline. Browsers block audio until a user gesture, so unlock() MUST be called from
// within a click handler (the Alerts toggle) before anything will play. Pure sound plumbing; WHEN to
// play is decided by the pure logic in alerts.ts and driven from useAudioAlerts.ts.

type OscType = "sine" | "square" | "triangle" | "sawtooth";

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

  /** A gentle two-note rising "attention" chime, played once. */
  chime(): void {
    if (!this.ctx) return;
    this.beep(660, 0, 0.12, 0.16, "sine");
    this.beep(880, 0.13, 0.16, 0.16, "sine");
  }

  /** Start the looping alarm: a harsh hi-lo two-tone repeating until stopAlarm(). Idempotent. */
  startAlarm(): void {
    if (!this.ctx || this.alarmTimer != null) return;
    const cycle = () => {
      this.beep(880, 0, 0.17, 0.3, "square");
      this.beep(620, 0.2, 0.17, 0.3, "square");
    };
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
