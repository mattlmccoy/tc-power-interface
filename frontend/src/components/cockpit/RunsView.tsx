// Runs (replay) view, spec §6: pick a recorded run, re-run the shadow loop on any recorded ROI and
// target, compare it with what the operator did, and scrub through the run. READ-ONLY: this view
// receives plain data (defaults and dial scales), never the operator object or a handler, and its
// only network calls are GETs (recordings, telemetry.csv, rois, shadow re-run).

import { useEffect, useMemo, useRef, useState } from "react";

import { api, type RecordingRun, type ReplayShadow } from "../../lib/api.ts";
import { f1, mmss } from "../../lib/cockpit/format.ts";
import { compareStats, parseTelemetry, runEvents, type ReplayEvent, type ReplayRow } from "../../lib/cockpit/replay.ts";
import { cursorIndex, mergeEvents, recorderEvents, replaySamples, shadowAt, shadowKey, valuesAt } from "../../lib/cockpit/replayView.ts";
import { confidenceSentence, shadowCard } from "../../lib/cockpit/shadowText.ts";
import { CockpitTimeline } from "./CockpitTimeline.tsx";
import { ReplayStrip, type ReplayScales } from "./ReplayStrip.tsx";

export interface RunsDefaults {
  targetC: number | null;
  controlRoi: string | null;
  scales: ReplayScales;
}

interface Loaded {
  run: string;
  rows: ReplayRow[];
  rois: string[];
  /** events.json placed on the rows' time axis; [] when absent (still recording, or crashed). */
  recEvents: ReplayEvent[];
  err: string | null;
}

const DEBOUNCE_MS = 400;
const PLAY_SPEED = 30; // replayed seconds per real second
const PLAY_TICK_MS = 100;
const fin = (x: number | null | undefined): x is number => x != null && Number.isFinite(x);
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

function RunList({ runs, err, sel, pick, reload }: {
  runs: RecordingRun[] | null; err: string | null; sel: string | null; pick: (r: string) => void; reload: () => void;
}) {
  return (
    <section className="panel ck-runlistpanel" aria-label="Recorded runs">
      <h2>
        <span>Recorded runs</span>
        <button className="btn ck-smallbtn" onClick={reload}>Refresh</button>
      </h2>
      <div className="ck-runlist">
        {err ? <div className="ck-sub ck-warnc">Could not list runs: {err}</div>
          : runs == null ? <div className="ck-sub">Loading…</div>
          : !runs.length ? <div className="ck-sub">No recordings yet.</div>
          : runs.map((r) => (
            <button key={r.run} className={`ck-runitem ${r.run === sel ? "on" : ""}`} onClick={() => pick(r.run)}>
              <div className="ck-runname mono" title={r.run}>{r.run}</div>
              <div className="ck-runmeta">
                <span className={`ck-tag ${r.has_roi_data ? "yes" : "no"}`}>
                  {r.has_roi_data ? "ROIs recorded" : "no ROI data — power, reflected, caps only"}
                </span>
                {!r.complete && <span className="ck-tag no">no manifest (recording or crashed)</span>}
                <span>{(r.size_bytes / 1024).toFixed(0)} kB</span>
              </div>
            </button>
          ))}
      </div>
    </section>
  );
}

export function RunsView({ defaults }: { defaults: RunsDefaults }) {
  const [runs, setRuns] = useState<RecordingRun[] | null>(null);
  const [listErr, setListErr] = useState<string | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [roi, setRoi] = useState("");
  const [targetText, setTargetText] = useState(fin(defaults.targetC) ? String(defaults.targetC) : "");
  const [shadow, setShadow] = useState<{ run: string; key: string; data: ReplayShadow } | null>(null);
  const [shadowState, setShadowState] = useState<{ key: string | null; busy: boolean; err: string | null }>({ key: null, busy: false, err: null });
  const [cursorS, setCursorS] = useState(0);
  const [playing, setPlaying] = useState(false);
  const selRef = useRef<string | null>(null);
  const keyRef = useRef<string | null>(null);

  const loadList = () => {
    setListErr(null);
    api.recordings()
      .then((r) => setRuns([...r].sort((a, b) => (a.run < b.run ? 1 : a.run > b.run ? -1 : 0)))) // newest first (names start YYYYMMDD_HHMMSS)
      .catch((e) => setListErr(errText(e)));
  };
  useEffect(loadList, []);

  function pick(run: string) {
    selRef.current = run;
    setSel(run);
    setPlaying(false);
    Promise.allSettled([api.recordingCsv(run), api.recordingRois(run), api.recordingEvents(run)]).then(([csv, rois, evs]) => {
      if (selRef.current !== run) return; // a later pick won
      let rows: ReplayRow[] = [];
      let ns0: bigint | null = null;
      let err: string | null = null;
      if (csv.status === "fulfilled") {
        try { ({ rows, ns0 } = parseTelemetry(csv.value)); } catch (e) { err = `telemetry.csv: ${errText(e)}`; }
      } else err = `telemetry.csv: ${errText(csv.reason)}`;
      const recEvents = evs.status === "fulfilled" && Array.isArray(evs.value) ? recorderEvents(evs.value, ns0) : [];
      const list = rois.status === "fulfilled" ? rois.value : [];
      if (rois.status === "rejected") err = [err, `ROIs: ${errText(rois.reason)}`].filter(Boolean).join(" · ");
      setLoaded({ run, rows, rois: list, recEvents, err });
      setRoi(defaults.controlRoi && list.includes(defaults.controlRoi) ? defaults.controlRoi : list[0] ?? "");
      setCursorS(rows.length ? rows[rows.length - 1].t_s : 0);
    });
  }

  const ready = loaded && loaded.run === sel ? loaded : null;
  const target = targetText.trim() === "" ? Number.NaN : Number(targetText);
  const key = shadowKey(ready?.run ?? null, roi, target);

  // Re-run the shadow loop on (run, ROI, target), debounced; a response for an older key is dropped.
  useEffect(() => {
    keyRef.current = key;
    if (!key || !ready) { setShadowState({ key: null, busy: false, err: null }); return; }
    setShadowState({ key, busy: true, err: null });
    const run = ready.run;
    const id = setTimeout(() => {
      api.replayShadow(run, roi, target)
        .then((data) => {
          if (keyRef.current !== key) return;
          setShadow({ run, key, data });
          setShadowState({ key, busy: false, err: null });
        })
        .catch((e) => keyRef.current === key && setShadowState({ key, busy: false, err: errText(e) }));
    }, DEBOUNCE_MS);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const rows = ready?.rows ?? [];
  const endS = rows.length ? rows[rows.length - 1].t_s : 0;
  useEffect(() => {
    if (!playing) return;
    const id = setInterval(() => {
      setCursorS((c) => {
        const n = Math.min(endS, c + (PLAY_SPEED * PLAY_TICK_MS) / 1000);
        if (n >= endS) setPlaying(false);
        return n;
      });
    }, PLAY_TICK_MS);
    return () => clearInterval(id);
  }, [playing, endS]);

  // The last re-run for THIS run stays on screen while a new one computes (no flicker).
  const pts = shadow && ready && shadow.run === ready.run ? shadow.data.points : null;
  const shownKey = pts ? shadow!.key : null;
  const samples = useMemo(() => replaySamples(rows, pts), [rows, pts]);
  const stats = useMemo(() => compareStats(rows, pts ?? []), [rows, pts]);
  const recEvents = ready?.recEvents;
  const events = useMemo(() => mergeEvents(runEvents(rows), recEvents ?? []), [rows, recEvents]);
  const at = valuesAt(rows, pts ?? [], cursorS);
  const sh = shadowAt(at.shadow);
  const evIdx = cursorIndex(events.map((e) => e.t_s), cursorS);
  const shownRoi = pts ? shadow!.data.roi : null;
  const partAt = pts ? at.shadow?.temp_c ?? null : at.row?.part_temp_c ?? null;
  const fwdAt = at.row?.forward_w ?? null;
  const card = sh ? shadowCard("target", sh, fwdAt ?? Number.NaN, shadow?.data.target_c ?? target) : null;
  const conf = sh ? Math.round(sh.confidence * 100) : null;
  const statusLine = !ready
    ? sel ? "Loading the run…" : "Pick a run on the left."
    : ready.err ? ready.err
    : !ready.rois.length ? "Temperatures not recorded in this run: power, reflected and caps only."
    : shadowState.err ? `Shadow re-run failed: ${shadowState.err}`
    : shadowState.busy ? "re-running the shadow loop…"
    : pts ? `Shadow loop re-run on ${shownRoi}, target ${shadow!.data.target_c} °C.` : "Enter a target to re-run the shadow loop.";
  const statusTone = ready?.err || shadowState.err ? "ck-warnc" : "ck-muted";

  return (
    <div className="ck-runsview">
      <div className="ck-runs">
        <RunList runs={runs} err={listErr} sel={sel} pick={pick} reload={loadList} />
        <section className="panel ck-replaypanel" aria-label="Replay (read-only)">
          <h2>
            <span>Replay · read-only</span>
            <span className="mono ck-replayname" title={sel ?? ""}>{sel ?? "no run selected"}</span>
          </h2>
          <div className="ck-inline">
            <label className="ck-lbl" htmlFor="ck-rp-roi">Control ROI</label>
            <select id="ck-rp-roi" className="ck-select" value={roi} disabled={!ready || !ready.rois.length} onChange={(e) => setRoi(e.target.value)}>
              {!ready || !ready.rois.length ? <option value="">no ROI data</option> : ready.rois.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
            <label className="ck-lbl ck-lbl-short" htmlFor="ck-rp-target">Target °C</label>
            <input id="ck-rp-target" className="ck-num" type="number" value={targetText} onChange={(e) => setTargetText(e.target.value)} />
          </div>
          <div className={`ck-rpstatus ${statusTone}`} title={statusLine}>{statusLine}</div>
          <div className="ck-compare">
            <div className="ck-card">
              <div className="ck-lbl">Your power vs shadow</div>
              <div className="ck-mid">{stats.meanAbsDiffW == null ? "—" : `${f1(stats.meanAbsDiffW)} W`}</div>
              <div className="ck-sub">
                {pts ? `mean |your forward − suggestion| over ${stats.pairedRows} of ${stats.rfOnRows} RF-on rows` : "needs a shadow re-run"}
              </div>
            </div>
            <div className="ck-card">
              <div className="ck-lbl">Reflected &gt; 1 %</div>
              <div className="ck-mid">{ready ? mmss(stats.reflHighS) : "—"}</div>
              <div className="ck-sub">{ready ? `of ${mmss(stats.rfOnS)} with RF on (at ≥ 1 W forward)` : ""}</div>
            </div>
            <div className="ck-card">
              <div className="ck-lbl">RF on</div>
              <div className="ck-mid">{ready ? mmss(stats.rfOnS) : "—"}</div>
              <div className="ck-sub">{ready ? `${stats.rfOnRows} rows · of ${mmss(endS)} recorded` : ""}</div>
            </div>
            <div className="ck-card">
              <div className="ck-lbl">Unknown</div>
              <div className="ck-mid">{ready ? mmss(stats.unknownS) : "—"}</div>
              <div className="ck-sub">{ready ? "gaps > 2 s or blank power readings" : ""}</div>
            </div>
          </div>
          <div className="ck-lbl" style={{ marginTop: 10 }}>Events · click to jump ({events.length})</div>
          <div className="ck-events" role="list">
            {events.map((e, k) => (
              <button key={k} role="listitem" className={k === evIdx ? "on" : ""} onClick={() => { setPlaying(false); setCursorS(e.t_s); }}>
                <span className="mono">{mmss(e.t_s)}</span><span>{e.text}</span>
              </button>
            ))}
          </div>
        </section>
      </div>

      <ReplayStrip row={at.row} scales={defaults.scales} />

      <CockpitTimeline
        buf={samples}
        mode="target"
        shadow={undefined}
        targetC={fin(target) ? target : null}
        watch={[]}
        controlRoi={shownRoi ?? (ready && !ready.rois.length ? "recorded control ROI" : roi || null)}
        replay={{ cursorS, plateauC: sh?.show ? sh.plateau_c : null, partC: partAt }}
      />
      <div className="ck-scrub">
        <button className="btn ck-playbtn" disabled={!rows.length} onClick={() => {
          if (!playing && cursorS >= endS) setCursorS(0);
          setPlaying(!playing);
        }}>
          {playing ? "❚❚ Pause" : "▶ Play (30×)"}
        </button>
        <input type="range" aria-label="Replay cursor" min={0} max={endS || 1} step={0.5} value={cursorS} disabled={!rows.length}
          onChange={(e) => { setPlaying(false); setCursorS(Number(e.target.value)); }} />
        <span className="mono ck-scrubtime">{rows.length ? `${mmss(cursorS)} / ${mmss(endS)}` : "—"}</span>
      </div>

      <div className="ck-cols2">
        <section className="panel" aria-label="Thermal at the cursor">
          <h2><span>Thermal · at cursor</span><span className="mono">{shownRoi ?? "—"}</span></h2>
          <div className="ck-row2">
            <div className="ck-card">
              <div className="ck-lbl">Part</div>
              <div className="ck-big">{f1(partAt)}<small> °C</small></div>
              <div className="ck-sub">{ready && !ready.rois.length ? "temperatures not recorded in this run" : pts ? `${shownRoi} (re-run input)` : "recorded control ROI"}</div>
            </div>
            <div className="ck-card">
              <div className="ck-lbl">Your forward</div>
              <div className="ck-big">{f1(fwdAt)}<small> W</small></div>
              <div className="ck-sub">{at.row ? (at.row.rf_on ? "RF on" : "RF off") : "no row at the cursor"}</div>
            </div>
          </div>
          <div className="ck-card ck-shadowcard">
            <div className="ck-lbl">{card?.label ?? "Shadow loop suggests"}</div>
            <div className={`ck-big ${!card || card.muted ? "ck-muted" : "ck-shadowc"}`}>{card?.value ?? "—"}</div>
            <div className="ck-sub ck-line">{card?.sub ?? (pts ? "no shadow point yet at the cursor" : "no shadow re-run")}</div>
            <dl className="ck-kv">
              <dt>Heating gain</dt><dd>{sh?.valid && fin(sh.k_c_per_w) ? `${sh.k_c_per_w.toFixed(3)} °C per W` : "—"}</dd>
              <dt>Time constant</dt><dd>{sh?.valid && fin(sh.tau_s) ? `${(sh.tau_s / 60).toFixed(1)} min` : "—"}</dd>
              <dt>Confidence</dt><dd>{conf == null ? "—" : `${conf} %`}</dd>
              <dt>Suggestion</dt><dd>{sh?.valid && fin(sh.suggest_w) ? `${f1(sh.suggest_w)} W` : "—"}</dd>
              <dt>Levels off at</dt><dd>{sh?.valid && fin(sh.plateau_c) ? `≈ ${f1(sh.plateau_c)} °C` : "—"}</dd>
            </dl>
            <div className="ck-bar"><i style={{ width: `${conf ?? 0}%` }} /></div>
            <div className="ck-sub ck-conf">{sh ? confidenceSentence(sh) : ""}</div>
          </div>
          <div className="ck-sub" title={shownKey ?? ""}>Re-run by the backend with the same estimator and shadow code as live (one implementation).</div>
        </section>
        <section className="panel" aria-label="Recorded readings at the cursor">
          <h2><span>Recorded · at cursor</span><span className="mono">{mmss(cursorS)}</span></h2>
          <dl className="ck-kv">
            <dt>Forward</dt><dd>{f1(at.row?.forward_w)} W</dd>
            <dt>Reflected</dt><dd>{f1(at.row?.reverse_w)} W{fin(at.row?.forward_w) && fin(at.row?.reverse_w) && at.row!.forward_w! >= 1 ? ` (${((100 * at.row!.reverse_w!) / at.row!.forward_w!).toFixed(1)} %)` : ""}</dd>
            <dt>Load</dt><dd>{f1(at.row?.load_w)} W</dd>
            <dt>Setpoint sent</dt><dd>{f1(at.row?.setpoint_w)} W</dd>
            <dt>Tune / Load cap</dt><dd>{f1(at.row?.tune)} % / {f1(at.row?.load)} %</dd>
            <dt>RF</dt><dd>{at.row ? (at.row.rf_on ? "on" : "off") : "—"}</dd>
            <dt>Last event</dt><dd>{evIdx >= 0 ? `${mmss(events[evIdx].t_s)} ${events[evIdx].text}` : "—"}</dd>
          </dl>
        </section>
      </div>
    </div>
  );
}
