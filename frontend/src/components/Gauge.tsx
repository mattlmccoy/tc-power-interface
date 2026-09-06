import { gaugeAngle } from "../lib/instrument.ts";

interface Props {
  label: string;
  value: number | null;
  max: number;
  unit?: string;
}

// Faithful, COMPACT replica of the reference analog dial: a wide shallow arc of dense tick marks
// with bold upright numerals sitting OUTSIDE the arc, and a SHORT needle from a pivot just below the
// arc so the whole meter is a short horizontal band (minimal vertical space). Cream face.
const CX = 100;
const CY = 60; // pivot sits just under the arc (short needle)
const R = 46; // tick-arc radius
const NUM_R = 55; // numerals sit outside the ticks (like the reference)
const NEEDLE = 42; // SHORT needle
const START = -62;
const END = 62;
const DIVS = 24; // dense divisions
const MAJOR_EVERY = 6; // labeled majors at 0/25/50/75/100 %

const FACE_TICK = "#33383e";
const FACE_MINOR = "#5a6068";
const FACE_NEEDLE = "#b3261e";
const FACE_PIVOT = "#1a1d21";
const NUM_FONT = "'Arial Narrow', 'Helvetica Neue', Arial, sans-serif";

function polar(angleDeg: number, r: number): [number, number] {
  const a = (angleDeg * Math.PI) / 180;
  return [CX + r * Math.sin(a), CY - r * Math.cos(a)];
}

/** Faithful compact analog dial: cream face, dense-tick shallow arc, bold numerals, short needle. */
export function Gauge({ label, value, max, unit = "W" }: Props) {
  const v = value ?? 0;
  const angle = gaugeAngle(v, 0, max, START, END);
  const a = (angle * Math.PI) / 180;
  const ux = Math.sin(a);
  const uy = -Math.cos(a);
  const px = Math.cos(a);
  const py = Math.sin(a);
  const tip: [number, number] = [CX + NEEDLE * ux, CY + NEEDLE * uy];
  const baseHalf = 2;
  const b1 = `${CX + baseHalf * px},${CY + baseHalf * py}`;
  const b2 = `${CX - baseHalf * px},${CY - baseHalf * py}`;

  const ticks = [];
  for (let i = 0; i <= DIVS; i++) {
    const ta = START + (i / DIVS) * (END - START);
    const major = i % MAJOR_EVERY === 0;
    const [x1, y1] = polar(ta, R);
    const [x2, y2] = polar(ta, R - (major ? 9 : 4.5));
    ticks.push(
      <line
        key={`k${i}`}
        x1={x1}
        y1={y1}
        x2={x2}
        y2={y2}
        stroke={major ? FACE_TICK : FACE_MINOR}
        strokeWidth={major ? 1.6 : 0.7}
      />,
    );
    if (major) {
      const [lx, ly] = polar(ta, NUM_R);
      ticks.push(
        <text
          key={`l${i}`}
          x={lx}
          y={ly}
          fontSize="11"
          fontFamily={NUM_FONT}
          fontWeight="700"
          fill={FACE_TICK}
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
        <polygon points={`${b1} ${tip[0]},${tip[1]} ${b2}`} fill={FACE_NEEDLE} />
        <circle cx={CX} cy={CY} r="3.4" fill={FACE_PIVOT} />
        <circle cx={CX} cy={CY} r="1.2" fill="#e7e9e4" />
      </svg>
      <div className="gauge-readout">
        {value === null ? "—" : v.toFixed(0)} <span className="gauge-unit">{unit}</span>
      </div>
    </div>
  );
}
