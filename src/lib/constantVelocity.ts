import { linearRegression, type LinearFit } from './regression';

/**
 * 등속 구간 자동 탐지
 *
 * 1) 각 점에서 시작하는 길이 windowSec(기본 0.5초)의 창마다 선형 회귀를 한다.
 * 2) R² ≥ r2Min 이고 기울기가 0이 아닌 창만 '좋은 창'으로 본다.
 * 3) 연속한 좋은 창들 중, 모든 창의 기울기가 그 묶음 평균 기울기의 ±slopeTol(기본 10%) 안에
 *    드는 가장 긴 묶음을 찾는다.
 * 4) 그 묶음이 덮는 시간 전체를 등속 구간으로 하고, 구간 전체로 다시 회귀해 속도를 구한다.
 */

export interface CVOptions {
  windowSec: number;
  slopeTol: number;
  r2Min: number;
  /** 한 창에 필요한 최소 점 개수 */
  minPoints: number;
}

export const DEFAULT_CV_OPTIONS: CVOptions = {
  windowSec: 0.5,
  slopeTol: 0.1,
  r2Min: 0.98,
  minPoints: 4,
};

export interface WindowFit {
  startIdx: number;
  endIdx: number; // 포함
  fit: LinearFit;
  good: boolean;
}

export interface Segment {
  startIdx: number;
  endIdx: number; // 포함
  tStart: number;
  tEnd: number;
  fit: LinearFit;
  /** 속력 = |기울기| (mm/s) */
  speed: number;
  /** 구간을 이루는 창 개수 (수동 선택이면 0) */
  windowCount: number;
}

export interface CVResult {
  segment: Segment | null;
  windows: WindowFit[];
}

export function slidingWindows(
  t: readonly number[],
  x: readonly number[],
  opts: CVOptions = DEFAULT_CV_OPTIONS,
): WindowFit[] {
  const n = t.length;
  const out: WindowFit[] = [];
  const eps = 1e-9;
  const tLast = t[n - 1];
  let j = 0;
  for (let i = 0; i < n; i++) {
    const tEndWanted = t[i] + opts.windowSec;
    if (tEndWanted > tLast + eps) break; // 끝까지 다 채워지는 창만
    if (j < i) j = i;
    while (j + 1 < n && t[j + 1] <= tEndWanted + eps) j++;
    const count = j - i + 1;
    if (count < opts.minPoints) continue;
    const fit = linearRegression(t, x, i, j + 1);
    if (!fit) continue;
    const good = fit.r2 >= opts.r2Min && Math.abs(fit.slope) > 1e-9;
    out.push({ startIdx: i, endIdx: j, fit, good });
  }
  return out;
}

export function detectConstantVelocity(
  t: readonly number[],
  x: readonly number[],
  options: Partial<CVOptions> = {},
): CVResult {
  const opts = { ...DEFAULT_CV_OPTIONS, ...options };
  if (t.length !== x.length) throw new Error('시간과 위치 데이터 개수가 달라요.');
  if (t.length < opts.minPoints) return { segment: null, windows: [] };

  const windows = slidingWindows(t, x, opts);
  let best: { a: number; b: number; span: number; r2: number } | null = null;

  for (let a = 0; a < windows.length; a++) {
    if (!windows[a].good) continue;
    let sum = 0;
    let min = Infinity;
    let max = -Infinity;
    let r2sum = 0;
    let lastOk = -1;
    for (let b = a; b < windows.length; b++) {
      const w = windows[b];
      // 창 시작점이 연속이어야 함 (중간에 빠진 창이 있으면 끊김)
      if (!w.good || (b > a && w.startIdx !== windows[b - 1].startIdx + 1)) break;
      const s = w.fit.slope;
      const nSum = sum + s;
      const nMin = Math.min(min, s);
      const nMax = Math.max(max, s);
      const m = nSum / (b - a + 1);
      const tol = opts.slopeTol * Math.abs(m);
      if (Math.abs(nMax - m) > tol || Math.abs(nMin - m) > tol || Math.sign(nMin) !== Math.sign(nMax)) break;
      sum = nSum;
      min = nMin;
      max = nMax;
      r2sum += w.fit.r2;
      lastOk = b;
    }
    if (lastOk < 0) continue;
    const span = t[windows[lastOk].endIdx] - t[windows[a].startIdx];
    const r2 = r2sum / (lastOk - a + 1);
    if (!best || span > best.span + 1e-9 || (Math.abs(span - best.span) <= 1e-9 && r2 > best.r2)) {
      best = { a, b: lastOk, span, r2 };
    }
  }

  if (!best) return { segment: null, windows };
  const startIdx = windows[best.a].startIdx;
  const endIdx = windows[best.b].endIdx;
  const segment = segmentFromRange(t, x, startIdx, endIdx);
  if (!segment) return { segment: null, windows };
  segment.windowCount = best.b - best.a + 1;
  return { segment, windows };
}

/** 사용자가 고른 시간 범위 [t1, t2]로 구간을 만든다 (수동 선택). */
export function segmentFromTimes(
  t: readonly number[],
  x: readonly number[],
  t1: number,
  t2: number,
): Segment | null {
  const lo = Math.min(t1, t2);
  const hi = Math.max(t1, t2);
  let s = -1;
  let e = -1;
  for (let i = 0; i < t.length; i++) {
    if (t[i] >= lo - 1e-9 && t[i] <= hi + 1e-9) {
      if (s < 0) s = i;
      e = i;
    }
  }
  if (s < 0 || e - s + 1 < 3) return null;
  return segmentFromRange(t, x, s, e);
}

function segmentFromRange(t: readonly number[], x: readonly number[], s: number, e: number): Segment | null {
  const fit = linearRegression(t, x, s, e + 1);
  if (!fit) return null;
  return {
    startIdx: s,
    endIdx: e,
    tStart: t[s],
    tEnd: t[e],
    fit,
    speed: Math.abs(fit.slope),
    windowCount: 0,
  };
}
