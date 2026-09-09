import assert from 'node:assert/strict';
import test from 'node:test';
import { bandwidth, db, demoSweep, impedance, magnitude, nearestPointByFrequency, phase, reflectedPowerPercent, vswr, type SweepPoint } from './rf.ts';

test('matched load produces 50 ohms and VSWR 1:1', () => {
  const reflection = { re: 0, im: 0 };
  assert.deepEqual(impedance(reflection), { re: 50, im: 0 });
  assert.equal(vswr(reflection), 1);
  assert.equal(magnitude(reflection), 0);
});

test('reflection coefficient one third produces 100 ohms', () => {
  const result = impedance({ re: 1 / 3, im: 0 });
  assert.ok(Math.abs(result.re - 100) < 1e-10);
  assert.equal(result.im, 0);
});

test('complex display quantities retain sign and units-ready values', () => {
  const reflection = { re: 0, im: 0.5 };
  assert.ok(Math.abs(db(reflection) + 6.020599913) < 1e-6);
  assert.equal(phase(reflection), 90);
  assert.equal(vswr(reflection), 3);
});

test('reflected power is the squared S11 magnitude as a percentage', () => {
  assert.equal(reflectedPowerPercent({ re: 0, im: 0 }), 0);
  assert.equal(reflectedPowerPercent({ re: 0.5, im: 0 }), 25);
  assert.ok(Math.abs(reflectedPowerPercent({ re: Math.sqrt(0.1), im: 0 }) - 10) < 1e-12);
});

test('VSWR does not hide invalid reflection magnitudes behind a finite clamp', () => {
  assert.equal(vswr({ re: 1, im: 0 }), Number.POSITIVE_INFINITY);
  assert.equal(vswr({ re: 1.2, im: 0 }), Number.POSITIVE_INFINITY);
});

test('bandwidth uses raw threshold crossings without smoothing', () => {
  const magnitudes = [0.8, 0.2, 0.1, 0.2, 0.8];
  const points: SweepPoint[] = magnitudes.map((value, index) => ({
    frequency: index * 1e6,
    s11: { re: value, im: 0 },
    s21: { re: 1, im: 0 },
  }));
  assert.equal(bandwidth(points, -10), 2e6);
});

test('demo trace has the requested unresampled point count', () => {
  const points = demoSweep(1e6, 2e6, 101);
  assert.equal(points.length, 101);
  assert.equal(points[0].frequency, 1e6);
  assert.equal(points.at(-1)?.frequency, 2e6);
});

test('reference matching uses nearest frequency rather than array index', () => {
  const points = demoSweep(1e6, 5e6, 5);
  assert.equal(nearestPointByFrequency(points, 3.7e6)?.frequency, 4e6);
  assert.equal(nearestPointByFrequency([], 3.7e6), null);
});
