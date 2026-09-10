// Vendored from nanovna-web (github.com/mattlmccoy/nanovna-web) @ ded36f3527645561a0f2055fbef93e051eb6db5d
// MIT License, (c) 2026 Matthew McCoy. See ./PROVENANCE.md. Do not edit here; re-sync from upstream.
import type { Complex, SweepPoint } from './rf';

interface SerialReader {
  read(): Promise<{ value?: Uint8Array; done: boolean }>;
  cancel(): Promise<void>;
  releaseLock(): void;
}

interface SerialWriter {
  write(value: Uint8Array): Promise<void>;
  releaseLock(): void;
}

interface SerialPortLike {
  readable: { getReader(): SerialReader } | null;
  writable: { getWriter(): SerialWriter } | null;
  open(options: { baudRate: number; bufferSize?: number }): Promise<void>;
  close(): Promise<void>;
}

interface SerialNavigator extends Navigator {
  serial?: {
    requestPort(options?: { filters?: Array<{ usbVendorId?: number; usbProductId?: number }> }): Promise<SerialPortLike>;
  };
}

export type CalibrationStep = 'load' | 'open' | 'short' | 'thru' | 'isoln';

export interface NanoVNACapabilities {
  scan: boolean;
  scanMask: boolean;
  currentData: boolean;
  calibration: boolean;
  calibrationSlots: boolean;
  pauseResume: boolean;
  bandwidth: boolean;
}

export interface SweepUpdate {
  points: SweepPoint[];
  completedSegments: number;
  totalSegments: number;
  progress: number;
}

export interface SweepResult extends SweepUpdate {
  cancelled: boolean;
  complete: boolean;
}

const DISLORD_BANDWIDTH_CODES: Record<number, number> = { 10: 363, 33: 117, 50: 78, 100: 39, 200: 19, 250: 15, 333: 11, 500: 7, 1000: 3, 2000: 1, 4000: 0 };

export function parseBandwidthResponse(lines: string[]): { options: number[]; method: 'direct' | 'dislord' | null } {
  const response = lines.join(' ');
  if (/Hz\)/i.test(response)) return { options: Object.keys(DISLORD_BANDWIDTH_CODES).map(Number), method: 'dislord' };
  const choices = response.match(/\{([^}]+)\}/)?.[1]?.split('|').map((value) => Number(value.trim())).filter((value) => Number.isFinite(value) && value > 0) ?? [];
  return choices.length ? { options: [...new Set(choices)].sort((a, b) => a - b), method: 'direct' } : { options: [], method: null };
}

function parseComplex(line: string): Complex | null {
  const values = line.trim().split(/\s+/).map(Number);
  if (values.length < 2 || values.some((value) => !Number.isFinite(value))) return null;
  return { re: values[0], im: values[1] };
}

function versionTuple(version: string): number[] {
  const match = version.match(/(\d+)\.(\d+)\.(\d+)/);
  return match ? match.slice(1).map(Number) : [0, 0, 0];
}

export function atLeastVersion(version: string, expected: [number, number, number]): boolean {
  const current = versionTuple(version);
  for (let index = 0; index < expected.length; index += 1) {
    if (current[index] > expected[index]) return true;
    if (current[index] < expected[index]) return false;
  }
  return true;
}

export function segmentRanges(start: number, stop: number, points: number, segments: number, logarithmic = false): Array<{ start: number; stop: number }> {
  if (logarithmic) {
    if (!(start > 0) || !(stop > start)) throw new Error('Logarithmic sweeps require a positive start frequency below the stop frequency.');
    const ratio = stop / start;
    const ranges = Array.from({ length: segments }, (_, index) => ({ start: Math.round(start * ratio ** (index / segments)), stop: Math.round(start * ratio ** ((index + 1) / segments)) }));
    if (ranges.some((range, index) => range.stop <= range.start || (index > 0 && range.stop <= ranges[index - 1].stop))) throw new Error('The requested logarithmic span is too narrow for this many segments after whole-hertz rounding.');
    return ranges;
  }
  const step = Math.round((stop - start) / (points * segments - 1));
  return Array.from({ length: segments }, (_, index) => {
    const segmentStart = start + index * points * step;
    return { start: segmentStart, stop: segmentStart + (points - 1) * step };
  });
}

export function parseShellCommands(helpLines: string[]): Set<string> {
  const ignored = new Set(['commands', 'command', 'usage', 'ch']);
  return new Set(helpLines.join(' ').toLowerCase().split(/[^a-z0-9_]+/).filter((token) => token && !ignored.has(token)));
}

export function validateCalibrationSlot(slot: number): number {
  if (!Number.isInteger(slot) || slot < 0 || slot > 4) throw new Error('Calibration slot must be an integer from 0 through 4.');
  return slot;
}

export function assembleCurrentSweep(frequencyLines: string[], s11Lines: string[], s21Lines: string[], verificationFrequencyLines: string[]): SweepPoint[] {
  const frequencies = frequencyLines.map(Number);
  const verificationFrequencies = verificationFrequencyLines.map(Number);
  const s11Rows = s11Lines.map(parseComplex);
  const s21Rows = s21Lines.map(parseComplex);
  if (frequencies.some((value) => !Number.isFinite(value)) || verificationFrequencies.some((value) => !Number.isFinite(value)) || s11Rows.some((value) => value === null) || s21Rows.some((value) => value === null)) {
    throw new Error('The current device buffers contained a malformed or nonfinite row. The previous valid plot was retained.');
  }
  if (frequencies.length !== verificationFrequencies.length || frequencies.some((frequency, index) => frequency !== verificationFrequencies[index])) {
    throw new Error('The device frequency grid changed while its buffers were being read. The previous valid plot was retained.');
  }
  if (frequencies.some((frequency, index) => index > 0 && frequency <= frequencies[index - 1])) throw new Error('The current device frequency grid is not strictly increasing. The previous valid plot was retained.');
  const s11 = s11Rows as Complex[];
  const s21 = s21Rows as Complex[];
  if (!frequencies.length || frequencies.length !== s11.length || s11.length !== s21.length) throw new Error(`Incomplete current display: ${frequencies.length} frequencies, ${s11.length} S11 rows, ${s21.length} S21 rows.`);
  return frequencies.map((frequency, index) => ({ frequency, s11: s11[index], s21: s21[index] }));
}

function mean(values: Complex[]): Complex {
  return { re: values.reduce((sum, value) => sum + value.re, 0) / values.length, im: values.reduce((sum, value) => sum + value.im, 0) / values.length };
}

export function averageSweepSets(sets: SweepPoint[][], truncateCount = 0): SweepPoint[] {
  if (!sets.length || !sets[0].length) throw new Error('No sweep data were available to average.');
  if (!Number.isInteger(truncateCount) || truncateCount < 0 || truncateCount >= sets.length) throw new Error('Truncated-average discard count must be a nonnegative integer smaller than the number of measurements.');
  const count = sets[0].length;
  if (sets.some((set) => set.length !== count || set.some((point, index) => point.frequency !== sets[0][index].frequency))) throw new Error('Averaged sweeps must use identical frequency grids.');
  const averageChannel = (index: number, channel: 's11' | 's21') => {
    const samples = sets.map((set) => set[index][channel]);
    if (!truncateCount) return mean(samples);
    const center = mean(samples);
    const retained = samples.slice().sort((a, b) => Math.hypot(a.re - center.re, a.im - center.im) - Math.hypot(b.re - center.re, b.im - center.im)).slice(0, samples.length - truncateCount);
    return mean(retained);
  };
  return sets[0].map((point, index) => ({ frequency: point.frequency, s11: averageChannel(index, 's11'), s21: averageChannel(index, 's21') }));
}

export class NanoVNAConnection {
  private port: SerialPortLike | null = null;
  private reader: SerialReader | null = null;
  private writer: SerialWriter | null = null;
  private decoder = new TextDecoder();
  private encoder = new TextEncoder();
  private operationQueue: Promise<void> = Promise.resolve();
  private closing = false;
  private bandwidthMethod: 'direct' | 'dislord' | null = null;
  version = 'Unknown firmware';
  calibration = 'Unknown';
  supportsScan = false;
  supportsScanMask = false;
  commands = new Set<string>();
  capabilities: NanoVNACapabilities = { scan: false, scanMask: false, currentData: false, calibration: false, calibrationSlots: false, pauseResume: false, bandwidth: false };

  static supported(): boolean {
    return Boolean((navigator as SerialNavigator).serial);
  }

  async connect(): Promise<string> {
    this.closing = false;
    const serial = (navigator as SerialNavigator).serial;
    if (!serial) throw new Error('Web Serial is unavailable. Use desktop Chrome or Edge.');
    try {
      this.port = await serial.requestPort();
      await this.port.open({ baudRate: 115200, bufferSize: 65536 });
      if (!this.port.readable || !this.port.writable) throw new Error('The selected serial port is not readable and writable.');
      this.reader = this.port.readable.getReader();
      this.writer = this.port.writable.getWriter();
      await this.write('\r');
      await this.readUntilPrompt(3000);
      const versionLines = await this.command('version');
      this.version = versionLines[0] || 'Unknown firmware';
      this.commands = parseShellCommands(await this.command('help'));
      this.supportsScan = this.commands.has('scan') && atLeastVersion(this.version, [0, 2, 0]);
      this.supportsScanMask = this.commands.has('scan') && atLeastVersion(this.version, [0, 7, 1]);
      this.capabilities = {
        scan: this.supportsScan,
        scanMask: this.supportsScanMask,
        currentData: this.commands.has('frequencies') && this.commands.has('data'),
        calibration: this.commands.has('cal'),
        calibrationSlots: this.commands.has('cal') && this.commands.has('save') && this.commands.has('recall'),
        pauseResume: this.commands.has('pause') && this.commands.has('resume'),
        bandwidth: this.commands.has('bandwidth'),
      };
      if (this.capabilities.calibration) await this.refreshCalibrationRaw();
      return this.version;
    } catch (error) {
      await this.disconnect();
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    this.closing = true;
    try { await this.operationQueue; } catch { /* a failed operation must not block cleanup */ }
    try { await this.reader?.cancel(); } catch { /* port may already be gone */ }
    try { this.reader?.releaseLock(); } catch { /* lock may already be released */ }
    try { this.writer?.releaseLock(); } catch { /* lock may already be released */ }
    this.reader = null;
    this.writer = null;
    try { await this.port?.close(); } catch { /* port may already be closed */ }
    this.port = null;
  }

  async sweep(start: number, stop: number, points: number, segments = 1, averages = 1, truncateCount = 0, logarithmic = false, onSegment?: (update: SweepUpdate) => void, isCancelled?: () => boolean): Promise<SweepResult> {
    return this.runExclusive(async () => {
      if (!Number.isInteger(averages) || averages < 1 || averages > 99) throw new Error('Averages must be an integer from 1 through 99.');
      if (!Number.isInteger(truncateCount) || truncateCount < 0 || truncateCount >= averages) throw new Error('Truncated-average discard count must be smaller than the number of averages.');
      const result: SweepPoint[] = [];
      const ranges = segmentRanges(start, stop, points, segments, logarithmic);
      let completedSegments = 0;
      for (let segment = 0; segment < ranges.length; segment += 1) {
        if (isCancelled?.()) break;
        const measurements: SweepPoint[][] = [];
        for (let repeat = 0; repeat < averages; repeat += 1) {
          if (isCancelled?.()) break;
          measurements.push(await this.readSegment(ranges[segment].start, ranges[segment].stop, points));
        }
        if (measurements.length !== averages) break;
        const averaged = averageSweepSets(measurements, truncateCount);
        if (logarithmic && result.length && averaged[0]?.frequency === result.at(-1)?.frequency) averaged.shift();
        result.push(...averaged);
        completedSegments = segment + 1;
        onSegment?.({ points: result.slice(), completedSegments, totalSegments: segments, progress: completedSegments / segments });
      }
      const cancelled = Boolean(isCancelled?.()) && completedSegments < segments;
      return { points: result, completedSegments, totalSegments: segments, progress: completedSegments / segments, cancelled, complete: completedSegments === segments };
    });
  }

  async refreshCalibration(): Promise<string> {
    return this.runExclusive(() => this.refreshCalibrationRaw());
  }

  async readCurrentSweep(): Promise<SweepPoint[]> {
    return this.runExclusive(async () => {
      this.requireCapability('currentData', 'Current device-display data');
      const frequencyLines = await this.command('frequencies', 15000);
      const s11Lines = await this.command('data 0', 15000);
      const s21Lines = await this.command('data 1', 15000);
      const verificationFrequencyLines = await this.command('frequencies', 15000);
      return assembleCurrentSweep(frequencyLines, s11Lines, s21Lines, verificationFrequencyLines);
    });
  }

  async collectCalibration(step: CalibrationStep, start: number, stop: number, points: number): Promise<{ points: SweepPoint[]; state: string }> {
    return this.runExclusive(async () => {
      this.requireCapability('calibration', 'Device calibration commands');
      const values = await this.readSegment(start, stop, points);
      this.assertAccepted(`cal ${step}`, await this.command(`cal ${step}`, 15000));
      return { points: values, state: await this.refreshCalibrationRaw() };
    });
  }

  async resetCalibration(): Promise<string> {
    return this.runExclusive(async () => {
      this.requireCapability('calibration', 'Device calibration commands');
      this.assertAccepted('cal reset', await this.command('cal reset'));
      return this.refreshCalibrationRaw();
    });
  }

  async finishCalibration(): Promise<string> {
    return this.runExclusive(async () => {
      this.requireCapability('calibration', 'Device calibration commands');
      this.assertAccepted('cal done', await this.command('cal done', 15000));
      this.assertAccepted('cal on', await this.command('cal on'));
      return this.refreshCalibrationRaw();
    });
  }

  async setCalibrationEnabled(enabled: boolean): Promise<string> {
    return this.runExclusive(async () => {
      this.requireCapability('calibration', 'Device calibration commands');
      this.assertAccepted(`cal ${enabled ? 'on' : 'off'}`, await this.command(`cal ${enabled ? 'on' : 'off'}`));
      return this.refreshCalibrationRaw();
    });
  }

  async saveCalibrationSlot(slot: number): Promise<string> {
    return this.runExclusive(async () => {
      this.requireCapability('calibrationSlots', 'Calibration slot storage');
      const id = validateCalibrationSlot(slot);
      this.assertAccepted(`save ${id}`, await this.command(`save ${id}`, 15000));
      return this.refreshCalibrationRaw();
    });
  }

  async recallCalibrationSlot(slot: number): Promise<string> {
    return this.runExclusive(async () => {
      this.requireCapability('calibrationSlots', 'Calibration slot storage');
      const id = validateCalibrationSlot(slot);
      this.assertAccepted(`recall ${id}`, await this.command(`recall ${id}`, 15000));
      return this.refreshCalibrationRaw();
    });
  }

  async getBandwidths(): Promise<number[]> {
    return this.runExclusive(async () => {
      this.requireCapability('bandwidth', 'Device bandwidth control');
      const parsed = parseBandwidthResponse(await this.command('bandwidth'));
      this.bandwidthMethod = parsed.method;
      return parsed.options;
    });
  }

  async setBandwidth(bandwidth: number): Promise<void> {
    return this.runExclusive(async () => {
      this.requireCapability('bandwidth', 'Device bandwidth control');
      if (!Number.isInteger(bandwidth) || bandwidth <= 0) throw new Error('Bandwidth must be a positive integer in hertz.');
      if (!this.bandwidthMethod) this.bandwidthMethod = parseBandwidthResponse(await this.command('bandwidth')).method;
      if (!this.bandwidthMethod) throw new Error('The firmware did not report a recognized list of supported bandwidths.');
      const commandValue = this.bandwidthMethod === 'dislord' ? DISLORD_BANDWIDTH_CODES[bandwidth] : bandwidth;
      if (commandValue === undefined) throw new Error(`Bandwidth ${bandwidth} Hz is not supported by this firmware family.`);
      this.assertAccepted(`bandwidth ${commandValue}`, await this.command(`bandwidth ${commandValue}`));
    });
  }

  private async refreshCalibrationRaw(): Promise<string> {
    this.requireCapability('calibration', 'Device calibration commands');
    this.calibration = (await this.command('cal')).join(' ').trim() || 'No calibration terms reported';
    return this.calibration;
  }

  private runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closing) return Promise.reject(new Error('The NanoVNA connection is closing.'));
    const guardedOperation = () => {
      if (this.closing) throw new Error('The NanoVNA connection is closing.');
      return operation();
    };
    const result = this.operationQueue.then(guardedOperation, guardedOperation);
    this.operationQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  private requireCapability(capability: keyof NanoVNACapabilities, label: string) {
    if (!this.capabilities[capability]) throw new Error(`${label} are not advertised by this firmware.`);
  }

  private assertAccepted(command: string, lines: string[]) {
    const response = lines.join(' ');
    if (/\b(?:usage|error|err\b|invalid|unknown)\b/i.test(response)) throw new Error(`NanoVNA rejected “${command}”: ${response}`);
  }

  private async readSegment(start: number, stop: number, points: number): Promise<SweepPoint[]> {
    if (this.supportsScanMask) {
      // FAST path (what makes the native tool responsive): ONE combined scan returning freq + S11 + S21
      // (mask 0b111) — ~200 ms vs ~1.5 s for the four-command read below. A SHORT timeout means a rare
      // device hiccup falls back quickly instead of stalling on the full command timeout (that was the
      // v0.7.0 "30 s" lag). Columns: freq, S11 re, S11 im, S21 re, S21 im. [upstream to nanovna-web]
      try {
        const rows = await this.command(`scan ${start} ${stop} ${points} 0b111`, 3000);
        const values = rows.map((line) => line.trim().split(/\s+/).map(Number)).filter((row) => row.length >= 5 && row.every(Number.isFinite));
        if (values.length >= points / 2) {
          return values.map((row) => ({ frequency: row[0], s11: { re: row[1], im: row[2] }, s21: { re: row[3], im: row[4] } }));
        }
      } catch { /* fall through to the reliable two-scan path */ }
      // RELIABLE fallback: two scans (frequencies, then S11+S21) — the original vendored behavior.
      const frequencies = (await this.command(`scan ${start} ${stop} ${points} 0b001`, 8000)).map(Number).filter(Number.isFinite);
      const rows = await this.command(`scan ${start} ${stop} ${points} 0b110`, 8000);
      const values = rows.map((line) => line.trim().split(/\s+/).map(Number)).filter((row) => row.length >= 4 && row.every(Number.isFinite));
      if (frequencies.length !== values.length) throw new Error(`Device returned ${frequencies.length} frequencies and ${values.length} data rows.`);
      return frequencies.map((frequency, index) => ({ frequency, s11: { re: values[index][0], im: values[index][1] }, s21: { re: values[index][2], im: values[index][3] } }));
    }

    await this.command(`${this.supportsScan ? 'scan' : 'sweep'} ${start} ${stop} ${points}`, 15000);
    const frequencies = (await this.command('frequencies', 15000)).map(Number).filter(Number.isFinite);
    const s11 = (await this.command('data 0', 15000)).map(parseComplex).filter((value): value is Complex => value !== null);
    const s21 = (await this.command('data 1', 15000)).map(parseComplex).filter((value): value is Complex => value !== null);
    if (frequencies.length !== s11.length || s11.length !== s21.length) throw new Error(`Incomplete sweep: ${frequencies.length} frequencies, ${s11.length} S11 rows, ${s21.length} S21 rows.`);
    return frequencies.map((frequency, index) => ({ frequency, s11: s11[index], s21: s21[index] }));
  }

  private async command(command: string, timeout = 8000): Promise<string[]> {
    if (!this.writer || !this.reader) throw new Error('NanoVNA is not connected.');
    await this.write(`${command}\r`);
    const lines = await this.readUntilPrompt(timeout);
    return lines.filter((line) => line !== command && !line.startsWith('ch>'));
  }

  private async write(value: string): Promise<void> {
    if (!this.writer) throw new Error('Serial writer is unavailable.');
    await this.writer.write(this.encoder.encode(value));
  }

  private async readUntilPrompt(timeout: number): Promise<string[]> {
    if (!this.reader) throw new Error('Serial reader is unavailable.');
    const deadline = Date.now() + timeout;
    let text = '';
    while (!text.includes('ch>')) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error('NanoVNA did not respond before the command timed out.');
      const read = this.reader.read();
      let timer: ReturnType<typeof setTimeout> | undefined;
      let result: { value?: Uint8Array; done: boolean };
      try {
        result = await Promise.race([
          read,
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('NanoVNA command timed out. Reconnect the device before retrying.')), remaining); }),
        ]);
      } catch (error) {
        try { await this.reader.cancel(); } catch { /* cancellation is best effort */ }
        try { this.reader.releaseLock(); } catch { /* lock may already be released */ }
        this.reader = null;
        throw error;
      } finally {
        if (timer) clearTimeout(timer);
      }
      if (result.done) throw new Error('The serial connection closed unexpectedly.');
      if (result.value) text += this.decoder.decode(result.value, { stream: true });
    }
    return text.replace(/ch>[\s\S]*$/, '').split(/\r?\n|\r/).map((line) => line.trim()).filter(Boolean);
  }
}
