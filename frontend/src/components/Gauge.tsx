import { gaugeAngle } from "../lib/instrument.ts";

interface Props {
  label: string;
  value: number | null;
  max: number;
  unit?: string;
}

// Shallow panel-meter geometry: pivot low, long needle, a wide-but-shallow arc across the top
// (~10-o'clock to 2-o'clock, ~116°) like a classic analog gauge — NOT a deep half-circle.
const CX = 100;
const CY = 116; // pivot near the bottom (the "screw")
const R = 96; // arc radius
const NEEDLE = 88; // long needle
const START = -58; // ~10 o'clock
const END = 58; // ~2 o'clock

function polar(angleDeg: number, r: number): [number, number] {
  const a = (angleDeg * Math.PI) / 180;
  return [CX + r * Math.sin(a), CY - r * Math.cos(a)];
}

/** A CXN-style analog needle gauge (shallow arc + ticks + red needle + digital readout). */
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
    const [x2, y2] = polar(ta, R - (major ? 10 : 6));
    ticks.push(
      <line
        key={`k${i}`}
        x1={x1}
        y1={y1}
        x2={x2}
        y2={y2}
        stroke="var(--muted)"
        strokeWidth={major ? 1.5 : 1}
      />,
    );
    if (major) {
      const [lx, ly] = polar(ta, R - 20);
      ticks.push(
        <text
          key={`l${i}`}
          x={lx}
          y={ly}
          fontSize="9"
          fill="var(--muted)"
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
      <svg viewBox="0 0 200 126" className="gauge-svg" role="img" aria-label={`${label} ${v}`}>
        <path d={arc} fill="none" stroke="var(--line-strong)" strokeWidth="2" />
        {ticks}
        <line
          x1={CX}
          y1={CY}
          x2={nx}
          y2={ny}
          stroke="var(--err)"
          strokeWidth="2"
          strokeLinecap="round"
        />
        <circle cx={CX} cy={CY} r="4" fill="var(--fg-strong)" />
      </svg>
      <div className="gauge-readout">
        {value === null ? "—" : v.toFixed(0)} <span className="gauge-unit">{unit}</span>
      </div>
    </div>
  );
}
