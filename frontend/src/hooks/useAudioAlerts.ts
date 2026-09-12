// Audible alerts: turns the live operator snapshot into sound — a looping alarm on any FAULT (until
// dismissed or the condition clears) and an edge-triggered chime when reflected power enters the warn
// zone (or any advisory warning appears). The WHAT-to-play decisions are the pure functions in
// alerts.ts; this hook holds the small amount of React/Web-Audio glue.

import { useEffect, useRef, useState } from "react";

import { alarmShouldSound, alertLevelFor, nextDismissed, shouldChime } from "../lib/alerts.ts";
import { AlertAudio } from "../lib/audio.ts";
import type { Operator } from "./useOperator.ts";

const ALERTS_KEY = "tcp.alerts";

export function useAudioAlerts(op: Operator) {
  const [enabled, setEnabled] = useState<boolean>(() => {
    try {
      return localStorage.getItem(ALERTS_KEY) === "1";
    } catch {
      return false;
    }
  });
  const [alarmActive, setAlarmActive] = useState(false);
  const audioRef = useRef<AlertAudio | null>(null);
  if (audioRef.current == null) audioRef.current = new AlertAudio();
  const prevLevel = useRef<"alarm" | "chime" | "none">("none");
  const dismissed = useRef(false);

  const enable = (on: boolean) => {
    setEnabled(on);
    try {
      localStorage.setItem(ALERTS_KEY, on ? "1" : "0");
    } catch {
      /* storage unavailable — in-memory only */
    }
    if (on) {
      audioRef.current?.unlock(); // the toggle click is the gesture that unlocks the AudioContext
    } else {
      audioRef.current?.stopAlarm();
      setAlarmActive(false);
    }
  };

  const dismiss = () => {
    dismissed.current = true;
    audioRef.current?.stopAlarm();
    setAlarmActive(false);
  };

  // If alerts were left enabled across a reload, the AudioContext starts suspended — resume it on the
  // first user interaction (the browser's autoplay gate).
  useEffect(() => {
    if (!enabled) return;
    const unlock = () => audioRef.current?.unlock();
    window.addEventListener("pointerdown", unlock, { once: true });
    return () => window.removeEventListener("pointerdown", unlock);
  }, [enabled]);

  // Release the AudioContext on unmount.
  useEffect(() => () => audioRef.current?.close(), []);

  const level = alertLevelFor({
    state: op.ctrl?.state ?? "disconnected",
    rfOn: op.t?.rf_on ?? false,
    reverseW: op.t?.reverse_w ?? 0,
    maxReflectedW: op.limits?.max_reflected_w ?? 0,
    warnings: op.ctrl?.warnings ?? [],
  });

  // Drive the sounds off LEVEL TRANSITIONS: this effect only re-runs when `level` (or `enabled`)
  // actually changes, so a chime fires once per rising edge and the alarm starts/stops on the edge.
  useEffect(() => {
    const audio = audioRef.current;
    if (!enabled || !audio) {
      prevLevel.current = level;
      return;
    }
    if (shouldChime(prevLevel.current, level)) audio.chime();
    dismissed.current = nextDismissed(level, dismissed.current);
    if (alarmShouldSound(level, dismissed.current)) {
      audio.startAlarm();
      setAlarmActive(true);
    } else {
      audio.stopAlarm();
      setAlarmActive(false);
    }
    prevLevel.current = level;
  }, [level, enabled]);

  return { enabled, enable, dismiss, level, alarmActive };
}

export type AudioAlerts = ReturnType<typeof useAudioAlerts>;
