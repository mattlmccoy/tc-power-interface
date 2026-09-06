import { gaugeAngle } from "../lib/instrument.ts";

interface Props {
  label: string;
  value: number | null;
  max: number;
  unit?: string;
}

// Faithful analog panel-meter dial (the classic vacuum-gauge look): the pivot sits OFF-SCREEN below
// the viewBox, giving a flat/wide shallow arc and a long thin needle rising from below. Dense thin
// "picket-fence" ticks (long/medium/short) with upright numerals above the arc, on a near-white face.
const VBW = 360;
const VBH = 132;
const CX = 180;
const CY = 350; // pivot far below the 132-tall viewBox → off-screen
const R = 300; // large radius → shallow flat arc
const NUM_R = 320;
const THETA = 30; // half-sweep (deg); ends ≈ CX ± R·sin(30) = ±150
const DIVS = 60;
const LABEL_EVERY = 10; // labels at 0/100/…/max
const MID_EVERY = 5;

const INK = "#151515";
const INK_MINOR = "#5b6067";
const NUM_FONT = "'Helvetica Neue', Arial, sans-serif";

function polar(deg: number, r: number): [number, number] {
  const a = (deg * Math.PI) / 180;
  return [CX + r * Math.sin(a), CY - r * Math.cos(a)];
}

/** Faithful vacuum-gauge-style dial: off-screen pivot, flat arc, picket-fence ticks, long needle. */
export function Gauge({ label, value, max, unit = "W" }: Props) {
  const v = value ?? 0;
  const ang = gaugeAngle(v, 0, max, -THETA, THETA);
  const a = (ang * Math.PI) / 180;
  const ux = Math.sin(a);
  const uy = -Math.cos(a);
  const px = Math.cos(a);
  const py = Math.sin(a);
  const [tipx, tipy] = [CX + (R - 8) * ux, CY - (R - 8) * uy];
  const bh = 1.5;
  const b1 = `${CX + bh * px},${CY + bh * py}`;
  const b2 = `${CX - bh * px},${CY - bh * py}`;

  const ticks = [];
  for (let i = 0; i <= DIVS; i++) {
    const ta = -THETA + (i / DIVS) * (2 * THETA);
    const labeled = i % LABEL_EVERY === 0;
    const mid = !labeled && i % MID_EVERY === 0;
    const len = labeled ? 16 : mid ? 12 : 9;
    const w = labeled ? 1.5 : mid ? 1.0 : 0.5;
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
          fontSize="13"
          fontWeight="600"
          fontFamily={NUM_FONT}
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
      <svg viewBox={`0 0 ${VBW} ${VBH}`} className="gauge-svg" role="img" aria-label={`${label} ${v}`}>
        {ticks}
        <polygon points={`${b1} ${tipx.toFixed(1)},${tipy.toFixed(1)} ${b2}`} fill={INK} />
      </svg>
      <div className="gauge-readout">
        {value === null ? "—" : v.toFixed(0)} <span className="gauge-unit">{unit}</span>
      </div>
    </div>
  );
}
