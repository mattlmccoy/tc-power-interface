import { gaugeAngle } from "../lib/instrument.ts";

interface Props {
  label: string;
  value: number | null;
  max: number;
  unit?: string;
}

// Compact analog panel-meter geometry: a wide, shallow ~10-to-2 arc, long needle from a low pivot,
// on a wider-than-tall face (like the reference vacuum gauge). Colors are a fixed light instrument
// face (not theme vars) so the dials read as real analog meters embedded in the console.
const CX = 100;
const CY = 88; // pivot near the bottom (the "screw")
const R = 82; // arc radius
const NEEDLE = 76; // long needle
const START = -60; // 10 o'clock
const END = 60; // 2 o'clock

const FACE_TICK = "#4a4f55";
const FACE_ARC = "#33383e";
const FACE_NEEDLE = "#c0392b";
const FACE_PIVOT = "#222";

function polar(angleDeg: number, r: number): [number, number] {
  const a = (angleDeg * Math.PI) / 180;
  return [CX + r * Math.sin(a), CY - r * Math.cos(a)];
}

/** A CXN-style analog needle gauge: compact light face, shallow wide arc, red needle + readout. */
export function Gauge({ label, value, max, unit = "W" }: Props) {
  const v = value ?? 0;
  const angle = gaugeAngle(v, 0, max, START, END);
  const [nx, ny] = polar(angle, NEEDLE);
  const [ax, ay] = polar(START, R);
  const [bx, by] = polar(END, R);
  const arc = `M ${ax} ${ay} A ${R} ${R} 0 0 1 ${bx} ${by}`;

  const steps = 8;
  const ticks = [];
  for (let i = 0; i <= steps; i++) {
    const ta = START + (i / steps) * (END - START);
    const major = i % 2 === 0;
    const [x1, y1] = polar(ta, R);
    const [x2, y2] = polar(ta, R - (major ? 9 : 5));
    ticks.push(
      <line
        key={`k${i}`}
        x1={x1}
        y1={y1}
        x2={x2}
        y2={y2}
        stroke={FACE_TICK}
        strokeWidth={major ? 1.5 : 0.9}
      />,
    );
    if (major) {
      const [lx, ly] = polar(ta, R - 18);
      ticks.push(
        <text
          key={`l${i}`}
          x={lx}
          y={ly}
          fontSize="9"
          fill={FACE_TICK}
          textAnchor="middle"
          dominantBaseline="middle"
        >
          {Math.round((i / steps) * max)}
        </text>,
      );
    }
  }

  return (
    <div className="gauge-card">
      <div className="gauge-label">{label}</div>
      <svg viewBox="0 0 200 96" className="gauge-svg" role="img" aria-label={`${label} ${v}`}>
        <path d={arc} fill="none" stroke={FACE_ARC} strokeWidth="1.5" />
        {ticks}
        <line
          x1={CX}
          y1={CY}
          x2={nx}
          y2={ny}
          stroke={FACE_NEEDLE}
          strokeWidth="1.8"
          strokeLinecap="round"
        />
        <circle cx={CX} cy={CY} r="3.5" fill={FACE_PIVOT} />
      </svg>
      <div className="gauge-readout">
        {value === null ? "—" : v.toFixed(0)} <span className="gauge-unit">{unit}</span>
      </div>
    </div>
  );
}
