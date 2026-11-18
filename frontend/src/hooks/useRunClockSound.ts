// Run-clock sounds: a soft "ding" at 2 min left, "ding-ding" at 30 s, and a "ding-dong" repeating
// every few seconds once the time is up, until dismissed or cancelled. Its OWN tones (CLOCK_TONES):
// never the fault / reflected-power warning sounds. WHEN to play is the pure
// soundFor() in lib/runClock.ts; this is the React/Web-Audio glue. Plays whether or not the general
// alerts bell is on (the chimes are the point), with a per-browser mute.

import { useEffect, useRef, useState } from "react";

import { AlertAudio, CLOCK_TONES } from "../lib/audio.ts";
import { soundFor, type RunClockBlock, type RunClockPhase } from "../lib/runClock.ts";

const MUTE_KEY = "tcp.runclock.mute";
/** The time's-up bells repeat this slowly (gentle reminder, not an alarm). */
const REPEAT_MS = 8000;

/** ``live``: the page is hearing from the operator. A stale page goes silent (it could never be
 * dismissed). ``silence()`` stops this screen's time's-up bells at once, before the operator
 * confirms the dismiss. */
export function useRunClockSound(rc: RunClockBlock | undefined, live: boolean) {
  const [silenced, setSilenced] = useState(false);
  const [muted, setMutedState] = useState<boolean>(() => {
    try {
      return localStorage.getItem(MUTE_KEY) === "1";
    } catch {
      return false;
    }
  });
  const audioRef = useRef<AlertAudio | null>(null);
  if (audioRef.current == null) audioRef.current = new AlertAudio();
  const prevPhase = useRef<RunClockPhase | null>(null);
  const loop = useRef<ReturnType<typeof setInterval> | null>(null);

  const setMuted = (on: boolean) => {
    setMutedState(on);
    try {
      localStorage.setItem(MUTE_KEY, on ? "1" : "0");
    } catch {
      /* storage unavailable: in-memory only */
    }
  };
  /** Call from a click (Set): browsers keep audio locked until a user gesture. */
  const unlock = () => audioRef.current?.unlock();

  // Any click on the page also unlocks audio (e.g. after a reload with a clock already running).
  useEffect(() => {
    const onDown = () => audioRef.current?.unlock();
    window.addEventListener("pointerdown", onDown);
    return () => window.removeEventListener("pointerdown", onDown);
  }, []);

  const phase = rc?.phase ?? "off";
  const dismissed = (rc?.dismissed ?? false) || silenced;
  // A local silence lasts until this time's-up is over (cancelled, +time, or a new clock).
  useEffect(() => {
    if (phase !== "over" && silenced) setSilenced(false);
  }, [phase, silenced]);
  useEffect(() => {
    const { chime, repeat } = soundFor(prevPhase.current, phase, dismissed, live);
    prevPhase.current = phase;
    if (chime && !muted) audioRef.current?.play(phase === "final" ? CLOCK_TONES.final : CLOCK_TONES.warn);
    if (repeat && !muted) {
      if (loop.current == null) {
        audioRef.current?.play(CLOCK_TONES.over);
        loop.current = setInterval(() => audioRef.current?.play(CLOCK_TONES.over), REPEAT_MS);
      }
    } else if (loop.current != null) {
      clearInterval(loop.current);
      loop.current = null;
    }
  }, [phase, dismissed, muted, live]);

  useEffect(
    () => () => {
      if (loop.current != null) clearInterval(loop.current);
      audioRef.current?.close();
    },
    [],
  );

  return { muted, setMuted, unlock, silence: () => setSilenced(true) };
}
