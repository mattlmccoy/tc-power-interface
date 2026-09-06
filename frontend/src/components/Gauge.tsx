import { gaugeAngle } from "../lib/instrument.ts";

interface Props {
  label: string;
  value: number | null;
  max: number;
  unit?: string;
}

// Retro analog panel-meter geometry: a wide, shallow ~10-to-2 arc, a long tapered needle from a low
// pivot with a small counterweight, dense tick marks and upright numerals on a cream face.
const CX = 100;
const CY = 90; // pivot near the bottom (the "screw")
const R = 84; // arc radius
const NEEDLE = 80; // long needle (nearly reaches the arc)
const TAIL = 12; // counterweight stub behind the pivot
const START = -60; // 10 o'clock
const END = 60; // 2 o'clock
const DIVS = 20; // dense minor divisions
const MAJOR_EVERY = 5; // a labeled major tick every 5th division (0/25/50/75/100%)

const FACE_TICK = "#3f444a";
const FACE_ARC = "#2b2f34";
const FACE_NEEDLE = "#b3261e";
const FACE_PIVOT = "#1a1d21";
const NUM_FONT = "'Arial Narrow', 'Helvetica Neue', Arial, sans-serif";

function polar(angleDeg: number, r: number): [number, number] {
  const a = (angleDeg * Math.PI) / 180;
  return [CX + r * Math.sin(a), CY - r * Math.cos(a)];
}

/** A retro CXN-style analog needle gauge: cream face, shallow arc, tapered red needle + readout. */
export function Gauge({ label, value, max, unit = "W" }: Props) {
  const v = value ?? 0;
  const angle = gaugeAngle(v, 0, max, START, END);
  const a = (angle * Math.PI) / 180;
  const ux = Math.sin(a);
  const uy = -Math.cos(a); // needle direction (unit)
  const px = Math.cos(a);
  const py = Math.sin(a); // perpendicular (unit)
  const tip: [number, number] = [CX + NEEDLE * ux, CY + NEEDLE * uy];
  const baseHalf = 2.2;
  const b1 = `${CX + baseHalf * px},${CY + baseHalf * py}`;
  const b2 = `${CX - baseHalf * px},${CY - baseHalf * py}`;
  const tail: [number, number] = [CX - TAIL * ux, CY - TAIL * uy];

  const [ax, ay] = polar(START, R);
  const [bx, by] = polar(END, R);
  const arc = `M ${ax} ${ay} A ${R} ${R} 0 0 1 ${bx} ${by}`;

  const ticks = [];
  for (let i = 0; i <= DIVS; i++) {
    const ta = START + (i / DIVS) * (END - START);
    const major = i % MAJOR_EVERY === 0;
    const [x1, y1] = polar(ta, R);
    const [x2, y2] = polar(ta, R - (major ? 11 : 5));
    ticks.push(
      <line
        key={`k${i}`}
        x1={x1}
        y1={y1}
        x2={x2}
        y2={y2}
        stroke={FACE_TICK}
        strokeWidth={major ? 1.6 : 0.7}
      />,
    );
    if (major) {
      const [lx, ly] = polar(ta, R - 20);
      ticks.push(
        <text
          key={`l${i}`}
          x={lx}
          y={ly}
          fontSize="10"
          fontFamily={NUM_FONT}
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
      <svg viewBox="0 0 200 98" className="gauge-svg" role="img" aria-label={`${label} ${v}`}>
        <path d={arc} fill="none" stroke={FACE_ARC} strokeWidth="1.4" />
        {ticks}
        {/* counterweight tail + tapered needle */}
        <line
          x1={CX}
          y1={CY}
          x2={tail[0]}
          y2={tail[1]}
          stroke={FACE_NEEDLE}
          strokeWidth="2.6"
          strokeLinecap="round"
        />
        <polygon points={`${b1} ${tip[0]},${tip[1]} ${b2}`} fill={FACE_NEEDLE} />
        <circle cx={CX} cy={CY} r="4" fill={FACE_PIVOT} />
        <circle cx={CX} cy={CY} r="1.4" fill="#e7e9e4" />
      </svg>
      <div className="gauge-readout">
        {value === null ? "—" : v.toFixed(0)} <span className="gauge-unit">{unit}</span>
      </div>
    </div>
  );
}
