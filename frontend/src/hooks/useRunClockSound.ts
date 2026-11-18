// Run-clock sounds: one chime on entering the 2-min and the 30-s warnings, and a chime repeating
// every few seconds once the time is up, until dismissed or cancelled. WHEN to play is the pure
// soundFor() in lib/runClock.ts; this is the React/Web-Audio glue. Plays whether or not the general
// alerts bell is on (the chimes are the point), with a per-browser mute.

import { useEffect, useRef, useState } from "react";

import { AlertAudio } from "../lib/audio.ts";
import { soundFor, type RunClockBlock, type RunClockPhase } from "../lib/runClock.ts";

const MUTE_KEY = "tcp.runclock.mute";
const REPEAT_MS = 2500;

export function useRunClockSound(rc: RunClockBlock | undefined) {
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
  const dismissed = rc?.dismissed ?? false;
  useEffect(() => {
    const { chime, repeat } = soundFor(prevPhase.current, phase, dismissed);
    prevPhase.current = phase;
    if (chime && !muted) audioRef.current?.chime();
    if (repeat && !muted) {
      if (loop.current == null) {
        audioRef.current?.chime();
        loop.current = setInterval(() => audioRef.current?.chime(), REPEAT_MS);
      }
    } else if (loop.current != null) {
      clearInterval(loop.current);
      loop.current = null;
    }
  }, [phase, dismissed, muted]);

  useEffect(
    () => () => {
      if (loop.current != null) clearInterval(loop.current);
      audioRef.current?.close();
    },
    [],
  );

  return { muted, setMuted, unlock };
}
