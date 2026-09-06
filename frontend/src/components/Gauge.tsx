import { gaugeAngle } from "../lib/instrument.ts";

interface Props {
  label: string;
  value: number | null;
  max: number;
  unit?: string;
}

// Faithful compact replica of the reference analog dial: a shallow arc of DENSE, varied-length tick
// marks (a 3-level long/medium/short hierarchy), bold upright numerals OUTSIDE the arc, and a thin
// black needle from a pivot just below the arc. Near-white face; short vertical footprint.
const CX = 100;
const CY = 60; // pivot just under the arc (short needle)
const R = 47; // tick-arc radius
const NUM_R = 56; // numerals sit outside the ticks
const NEEDLE = 43; // short needle
const START = -64;
const END = 64;
const DIVS = 48; // fine minor divisions
const LABEL_EVERY = 12; // labeled majors: 0/25/50/75/100 %
const MID_EVERY = 4; // medium ticks between labels

const INK = "#1b1e22";
const INK_MINOR = "#565c64";
const NUM_FONT = "'Arial Narrow', 'Helvetica Neue', Arial, sans-serif";

function polar(angleDeg: number, r: number): [number, number] {
  const a = (angleDeg * Math.PI) / 180;
  return [CX + r * Math.sin(a), CY - r * Math.cos(a)];
}

/** Faithful compact analog dial: near-white face, dense 3-level ticks, bold numerals, thin needle. */
export function Gauge({ label, value, max, unit = "W" }: Props) {
  const v = value ?? 0;
  const angle = gaugeAngle(v, 0, max, START, END);
  const a = (angle * Math.PI) / 180;
  const ux = Math.sin(a);
  const uy = -Math.cos(a);
  const px = Math.cos(a);
  const py = Math.sin(a);
  const tip: [number, number] = [CX + NEEDLE * ux, CY + NEEDLE * uy];
  const bh = 1.5;
  const b1 = `${CX + bh * px},${CY + bh * py}`;
  const b2 = `${CX - bh * px},${CY - bh * py}`;

  const ticks = [];
  for (let i = 0; i <= DIVS; i++) {
    const ta = START + (i / DIVS) * (END - START);
    const labeled = i % LABEL_EVERY === 0;
    const mid = !labeled && i % MID_EVERY === 0;
    const len = labeled ? 11 : mid ? 7 : 3.5;
    const w = labeled ? 1.7 : mid ? 1.0 : 0.6;
    const [x1, y1] = polar(ta, R);
    const [x2, y2] = polar(ta, R - len);
    ticks.push(
      <line
        key={`k${i}`}
        x1={x1}
        y1={y1}
        x2={x2}
        y2={y2}
        stroke={labeled || mid ? INK : INK_MINOR}
        strokeWidth={w}
      />,
    );
    if (labeled) {
      const [lx, ly] = polar(ta, NUM_R);
      ticks.push(
        <text
          key={`l${i}`}
          x={lx}
          y={ly}
          fontSize="10.5"
          fontFamily={NUM_FONT}
          fontWeight="700"
          fill={INK}
          textAnchor="middle"
          dominantBaseline="middle"
        >
          {Math.round((i / DIVS) * max)}
        </text>,
      );
    }
  }

  return (
    <div className="gauge-card">
      <div className="gauge-label">{label}</div>
      <svg viewBox="0 0 200 66" className="gauge-svg" role="img" aria-label={`${label} ${v}`}>
        {ticks}
        <polygon points={`${b1} ${tip[0]},${tip[1]} ${b2}`} fill={INK} />
        <circle cx={CX} cy={CY} r="2.6" fill={INK} />
      </svg>
      <div className="gauge-readout">
        {value === null ? "—" : v.toFixed(0)} <span className="gauge-unit">{unit}</span>
      </div>
    </div>
  );
}
