// Pure Smith-chart geometry. Maps complex reflection Γ and the normalized-impedance grid to screen
// coordinates for an SVG render. Closed-form (no fitting): in the Γ-plane (unit radius),
//   constant-resistance r  → circle centred at (r/(1+r), 0), radius 1/(1+r)
//   constant-reactance  x  → circle centred at (1, 1/x),     radius 1/|x|   (arcs, clipped to |Γ|=1)
// Screen mapping: x = cx + Γ.re·R, y = cy − Γ.im·R (screen y grows downward, so +reactance is up).

export interface SmithFrame {
  cx: number;
  cy: number;
  r: number;
}

export interface Circle {
  cx: number;
  cy: number;
  r: number;
}

/** Standard normalized grid values to draw (0.5, 1, 2 × 50 Ω = 25/50/100 Ω and j25/j50/j100). */
export const RESISTANCE_GRID = [0.5, 1, 2] as const;
export const REACTANCE_GRID = [0.5, 1, 2] as const;

/** Map a reflection coefficient to a screen point inside `frame`. */
export function gammaToXY(gamma: { re: number; im: number }, frame: SmithFrame): { x: number; y: number } {
  return { x: frame.cx + gamma.re * frame.r, y: frame.cy - gamma.im * frame.r };
}

/** Screen circle for constant normalized resistance `rNorm` (r = 0 is the unit circle itself). */
export function constResistanceCircle(rNorm: number, frame: SmithFrame): Circle {
  const k = 1 / (1 + rNorm);
  return { cx: frame.cx + rNorm * k * frame.r, cy: frame.cy, r: k * frame.r };
}

/** Screen circle for constant normalized reactance `xNorm` (sign gives the half-plane; drawn clipped
 *  to the unit circle). `xNorm` must be non-zero (x = 0 is the real axis). */
export function constReactanceCircle(xNorm: number, frame: SmithFrame): Circle {
  return { cx: frame.cx + frame.r, cy: frame.cy - (1 / xNorm) * frame.r, r: frame.r / Math.abs(xNorm) };
}
