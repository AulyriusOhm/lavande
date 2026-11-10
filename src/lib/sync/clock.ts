export type ClockState = { wallMs: number; counter: number };

export type Clock = { tick(): string; receive(remote: string): void; readonly last: ClockState };

const WALL_DIGITS = 15;
const COUNTER_DIGITS = 5;
const DEVICE_DIGITS = 6;
const WALL_LIMIT = 10 ** WALL_DIGITS;
const COUNTER_LIMIT = 10 ** COUNTER_DIGITS;
const HLC_PATTERN = /^(\d{15})-(\d{5})-([A-Za-z0-9]{0,6})$/;

function bounded(value: number, limit: number, field: string): string {
  if (!Number.isInteger(value) || value < 0 || value >= limit) {
    throw new Error(`HLC invalide : ${field} hors bornes (${value})`);
  }
  return String(value);
}

export function encodeHlc(state: ClockState, deviceId: string): string {
  const wall = bounded(state.wallMs, WALL_LIMIT, "wallMs").padStart(WALL_DIGITS, "0");
  const counter = bounded(state.counter, COUNTER_LIMIT, "counter").padStart(COUNTER_DIGITS, "0");
  const device = deviceId.replace(/[^A-Za-z0-9]/g, "").slice(0, DEVICE_DIGITS);
  return `${wall}-${counter}-${device}`;
}

export function decodeHlc(hlc: string): { state: ClockState; device: string } {
  const match = HLC_PATTERN.exec(hlc);
  if (match === null) throw new Error(`HLC invalide : ${hlc}`);
  return { state: { wallMs: Number(match[1]), counter: Number(match[2]) }, device: match[3] };
}

export function compareHlc(a: string, b: string): number {
  const left = decodeHlc(a);
  const right = decodeHlc(b);
  if (left.state.wallMs !== right.state.wallMs) return left.state.wallMs < right.state.wallMs ? -1 : 1;
  if (left.state.counter !== right.state.counter) return left.state.counter < right.state.counter ? -1 : 1;
  if (left.device === right.device) return 0;
  return left.device < right.device ? -1 : 1;
}

export function createClock(deviceId: string, now: () => number = Date.now): Clock {
  let state: ClockState = { wallMs: 0, counter: 0 };

  function advance(wallMs: number, counter: number): void {
    state = { wallMs, counter };
  }

  function receive(remote: string): void {
    const received = decodeHlc(remote).state;
    const wallMs = Math.max(state.wallMs, received.wallMs, Math.floor(now()));
    const localLeads = wallMs === state.wallMs;
    const remoteLeads = wallMs === received.wallMs;
    const counter = localLeads && remoteLeads
      ? Math.max(state.counter, received.counter) + 1
      : localLeads
        ? state.counter + 1
        : remoteLeads
          ? received.counter + 1
          : 0;
    advance(wallMs, counter);
  }

  function tick(): string {
    const wallMs = Math.max(state.wallMs, Math.floor(now()));
    advance(wallMs, wallMs === state.wallMs ? state.counter + 1 : 0);
    return encodeHlc(state, deviceId);
  }

  return {
    tick,
    receive,
    get last() {
      return { ...state };
    },
  };
}
