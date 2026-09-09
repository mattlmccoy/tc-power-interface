// Vendored from nanovna-web (github.com/mattlmccoy/nanovna-web) @ ded36f3527645561a0f2055fbef93e051eb6db5d
// MIT License, (c) 2026 Matthew McCoy. See ./PROVENANCE.md. Do not edit here; re-sync from upstream.
export interface Complex {
  re: number;
  im: number;
}

export interface SweepPoint {
  frequency: number;
  s11: Complex;
  s21: Complex;
}

export function magnitude(value: Complex): number {
  return Math.hypot(value.re, value.im);
}

export function db(value: Complex): number {
  return 20 * Math.log10(Math.max(magnitude(value), 1e-12));
}

export function reflectedPowerPercent(value: Complex): number {
  return magnitude(value) ** 2 * 100;
}

export function phase(value: Complex): number {
  return Math.atan2(value.im, value.re) * 180 / Math.PI;
}

export function vswr(value: Complex): number {
  const gamma = magnitude(value);
  if (gamma >= 1) return Number.POSITIVE_INFINITY;
  return (1 + gamma) / (1 - gamma);
}

export function impedance(value: Complex, z0 = 50): Complex {
  const denominator = (1 - value.re) ** 2 + value.im ** 2;
  return {
    re: z0 * (1 - value.re ** 2 - value.im ** 2) / denominator,
    im: z0 * (2 * value.im) / denominator,
  };
}

export function markerIndex(points: SweepPoint[]): number {
  if (!points.length) return 0;
  return points.reduce((best, point, index) => db(point.s11) < db(points[best].s11) ? index : best, 0);
}

export function nearestPointByFrequency(points: SweepPoint[], frequency: number): SweepPoint | null {
  if (!points.length) return null;
  return points.reduce((best, point) => Math.abs(point.frequency - frequency) < Math.abs(best.frequency - frequency) ? point : best, points[0]);
}

export function bandwidth(points: SweepPoint[], threshold = -10): number | null {
  if (points.length < 2) return null;
  const marker = markerIndex(points);
  if (db(points[marker].s11) > threshold) return null;
  let left = marker;
  let right = marker;
  while (left > 0 && db(points[left - 1].s11) <= threshold) left -= 1;
  while (right < points.length - 1 && db(points[right + 1].s11) <= threshold) right += 1;
  return points[right].frequency - points[left].frequency;
}

export function demoSweep(start = 140e6, stop = 147e6, count = 101): SweepPoint[] {
  return Array.from({ length: count }, (_, index) => {
    const x = index / (count - 1);
    const notch = 0.975 * Math.exp(-Math.pow((x - 0.57) / 0.105, 2));
    const mag = Math.max(0.018, 0.78 - notch + Math.sin(x * 16) * 0.025);
    const angle = -2.35 + x * 4.55;
    return {
      frequency: start + x * (stop - start),
      s11: { re: mag * Math.cos(angle), im: mag * Math.sin(angle) },
      s21: { re: 0.82 * Math.cos(x * 1.6), im: 0.82 * Math.sin(x * 1.6) },
    };
  });
}
