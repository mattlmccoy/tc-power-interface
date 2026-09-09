import assert from 'node:assert/strict';
import test from 'node:test';
import { assembleCurrentSweep, atLeastVersion, averageSweepSets, parseBandwidthResponse, parseShellCommands, segmentRanges, validateCalibrationSlot } from './nanovna.ts';

test('firmware comparison is lexicographic, not component-wise', () => {
  assert.equal(atLeastVersion('0.7.1', [0, 7, 1]), true);
  assert.equal(atLeastVersion('0.8.0', [0, 7, 1]), true);
  assert.equal(atLeastVersion('1.0.0', [0, 7, 1]), true);
  assert.equal(atLeastVersion('0.6.99', [0, 7, 1]), false);
  assert.equal(atLeastVersion('0.7.0', [0, 7, 1]), false);
});

test('firmware comparison tolerates labels around semantic versions', () => {
  assert.equal(atLeastVersion('NanoVNA-H firmware version 0.7.2', [0, 7, 1]), true);
  assert.equal(atLeastVersion('unknown', [0, 7, 1]), false);
});

test('segmented sweep matches NanoVNA Saver point and step semantics', () => {
  const ranges = segmentRanges(1e6, 51e6, 101, 10);
  assert.equal(ranges.length * 101, 1010);
  assert.deepEqual(ranges[0], { start: 1e6, stop: 5955400 });
  assert.deepEqual(ranges[1], { start: 6004954, stop: 10960354 });
  assert.equal(ranges[1].start - ranges[0].stop, 49554);
});

test('logarithmic segment endpoints follow equal ratios', () => {
  const ranges = segmentRanges(1e6, 1e9, 101, 3, true);
  assert.deepEqual(ranges, [{ start: 1e6, stop: 1e7 }, { start: 1e7, stop: 1e8 }, { start: 1e8, stop: 1e9 }]);
  assert.throws(() => segmentRanges(0, 1e9, 101, 3, true), /positive start/);
  assert.throws(() => segmentRanges(1, 2, 101, 10, true), /too narrow/);
});

test('shell capability parsing uses complete command tokens', () => {
  const commands = parseShellCommands(['Commands: scan cal save recall pause resume bandwidth']);
  assert.equal(commands.has('scan'), true);
  assert.equal(commands.has('cal'), true);
  assert.equal(commands.has('calibration'), false);
  assert.equal(commands.has('save'), true);
});

test('bandwidth responses distinguish direct hertz values from Dislord codes', () => {
  assert.deepEqual(parseBandwidthResponse(['bandwidth {100|1000|4000}']), { options: [100, 1000, 4000], method: 'direct' });
  const dislord = parseBandwidthResponse(['bandwidth 3 (1000 Hz)']);
  assert.equal(dislord.method, 'dislord');
  assert.equal(dislord.options.includes(10), true);
  assert.equal(dislord.options.includes(4000), true);
  assert.deepEqual(parseBandwidthResponse(['bandwidth']), { options: [], method: null });
});

test('calibration slots stay within the five-slot common firmware range', () => {
  assert.equal(validateCalibrationSlot(0), 0);
  assert.equal(validateCalibrationSlot(4), 4);
  assert.throws(() => validateCalibrationSlot(5), /0 through 4/);
  assert.throws(() => validateCalibrationSlot(1.5), /integer/);
});

test('current device buffers reject malformed rows and grid changes rather than mispairing data', () => {
  const frequencies = ['1000000', '2000000'];
  const s11 = ['0.1 0.2', '0.3 0.4'];
  const s21 = ['0.5 0.6', '0.7 0.8'];
  const points = assembleCurrentSweep(frequencies, s11, s21, frequencies);
  assert.equal(points.length, 2);
  assert.deepEqual(points[1].s21, { re: 0.7, im: 0.8 });
  assert.throws(() => assembleCurrentSweep(frequencies, ['bad row', '0.3 0.4'], s21, frequencies), /malformed/);
  assert.throws(() => assembleCurrentSweep(frequencies, s11, s21, ['1000000', '2100000']), /changed/);
  assert.throws(() => assembleCurrentSweep(['2000000', '1000000'], s11, s21, ['2000000', '1000000']), /strictly increasing/);
});

test('averaging and truncated averaging are deterministic and preserve the grid', () => {
  const make = (value: number) => [{ frequency: 1, s11: { re: value, im: 0 }, s21: { re: value * 2, im: 0 } }];
  assert.equal(averageSweepSets([make(1), make(2), make(3)])[0].s11.re, 2);
  assert.equal(averageSweepSets([make(1), make(2), make(100)], 1)[0].s11.re, 1.5);
  assert.throws(() => averageSweepSets([make(1), [{ ...make(2)[0], frequency: 2 }]]), /identical frequency grids/);
});
