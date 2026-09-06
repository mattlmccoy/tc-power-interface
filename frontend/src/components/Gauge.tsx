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
const VBH = 138; // cropped just below the floating needle (bottom truncated — no long tail)
const CX = 180;
const CY = 350; // virtual pivot far below → flat wide arc (the needle itself is truncated/floating)
const R = 300; // large radius → shallow flat arc
const NUM_R = 320;
const THETA = 30; // half-sweep (deg); ends ≈ CX ± R·sin(30) = ±150
const DIVS = 60;
const LABEL_EVERY = 10; // labels at 0/100/…/max
const MID_EVERY = 5;

const INK = "#151515";
const INK_MINOR = "#5b6067";
const NEEDLE = "#c0392b"; // floating pointer
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
  const px = Math.cos(a);
  const py = Math.sin(a); // perpendicular to the radial direction
  // Floating pointer: a short thick tapered needle just inside the arc (bottom truncated — it does
  // not reach the off-screen pivot), with a small hub at its base.
  const [tipx, tipy] = polar(ang, R - 3);
  const [basex, basey] = polar(ang, R - 46);
  const bH = 3.4; // base half-width (thick)
  const tH = 0.9; // tip half-width (near a point)
  const nb1 = `${(basex + bH * px).toFixed(1)},${(basey + bH * py).toFixed(1)}`;
  const nb2 = `${(basex - bH * px).toFixed(1)},${(basey - bH * py).toFixed(1)}`;
  const nt1 = `${(tipx + tH * px).toFixed(1)},${(tipy + tH * py).toFixed(1)}`;
  const nt2 = `${(tipx - tH * px).toFixed(1)},${(tipy - tH * py).toFixed(1)}`;

  // Warning zones just outside the ticks: yellow 400-500 W, red 500-max.
  const arcAt = (a0: number, a1: number, r: number) => {
    const [x0, y0] = polar(a0, r);
    const [x1, y1] = polar(a1, r);
    return `M ${x0.toFixed(1)} ${y0.toFixed(1)} A ${r} ${r} 0 0 1 ${x1.toFixed(1)} ${y1.toFixed(1)}`;
  };
  const zoneR = R + 7;
  const aWarn = gaugeAngle(Math.min(400, max), 0, max, -THETA, THETA);
  const aDanger = gaugeAngle(Math.min(500, max), 0, max, -THETA, THETA);

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
        {max > 400 ? (
          <path d={arcAt(aWarn, aDanger, zoneR)} fill="none" stroke="#e0a83a" strokeWidth="5" />
        ) : null}
        {max > 500 ? (
          <path d={arcAt(aDanger, THETA, zoneR)} fill="none" stroke="#cf3b2e" strokeWidth="5" />
        ) : null}
        {ticks}
        <polygon points={`${nb1} ${nt1} ${nt2} ${nb2}`} fill={NEEDLE} />
        <circle cx={basex.toFixed(1)} cy={basey.toFixed(1)} r="4" fill={NEEDLE} />
      </svg>
      <div className="gauge-readout">
        {value === null ? "—" : v.toFixed(0)} <span className="gauge-unit">{unit}</span>
      </div>
    </div>
  );
}
