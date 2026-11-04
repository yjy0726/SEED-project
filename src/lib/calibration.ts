import { linearRegression, type LinearFit } from './regression';
import { median, sampleSD } from './stats';

/** 표준곡선 점: 농도(mg/L)와 상대속도 v/v0 */
export interface StdPoint {
  conc: number;
  ratio: number;
}

/**
 * linear      : v/v0 = a + b·c                  (저농도에서만 맞음)
 * log         : v/v0 = a + b·log10(c)           (c > 0 인 점만, 중간~고농도에서 맞음)
 * szyszkowski : v/v0 = a + b·ln(1 + k·c)        (표면장력 이론 모형, b < 0 이면 B = −b)
 *   시슈코프스키 식 γ(c) = γ0 − RTΓ∞·ln(1 + K·c) 에서 나온 모양.
 *   k·c ≪ 1 이면 직선, k·c ≫ 1 이면 log c 에 직선 → 두 모형을 하나로 이음.
 */
export type CurveModel = 'linear' | 'log' | 'szyszkowski';

export interface CurveFit {
  model: CurveModel;
  a: number;
  b: number;
  /** szyszkowski 모형의 K (L/mg) */
  k?: number;
  r2: number;
  n: number;
  /** 회귀에 쓴 농도 범위 */
  cMin: number;
  cMax: number;
}

export function fitStandardCurve(points: readonly StdPoint[], model: CurveModel): CurveFit | null {
  if (model === 'szyszkowski') return fitSzyszkowski(points);
  const used = points.filter(
    (p) => isFinite(p.conc) && isFinite(p.ratio) && (model === 'linear' ? p.conc >= 0 : p.conc > 0),
  );
  if (used.length < 2) return null;
  const xs = used.map((p) => (model === 'log' ? Math.log10(p.conc) : p.conc));
  const ys = used.map((p) => p.ratio);
  const fit = linearRegression(xs, ys);
  if (!fit || fit.slope === 0) return null;
  const cs = used.map((p) => p.conc);
  return {
    model,
    a: fit.intercept,
    b: fit.slope,
    r2: fit.r2,
    n: fit.n,
    cMin: Math.min(...cs),
    cMax: Math.max(...cs),
  };
}

/**
 * v/v0 = a + b·ln(1 + k·c) 맞추기.
 * k 를 하나 정하면 x = ln(1 + k·c) 에 대한 직선 회귀가 되므로,
 * k 를 넓게 훑은 뒤(로그 간격) 황금분할 탐색으로 잔차제곱합이 가장 작은 k 를 찾는다.
 * 서로 다른 농도가 3개 이상 필요 (모수 3개).
 */
export function fitSzyszkowski(points: readonly StdPoint[]): CurveFit | null {
  const used = points.filter((p) => isFinite(p.conc) && isFinite(p.ratio) && p.conc >= 0);
  if (new Set(used.map((p) => p.conc)).size < 3) return null;
  const pos = used.filter((p) => p.conc > 0).map((p) => p.conc);
  const cMax = Math.max(...pos);
  const cMinPos = Math.min(...pos);
  const ys = used.map((p) => p.ratio);
  const fitAt = (lnK: number) => {
    const k = Math.exp(lnK);
    return linearRegression(used.map((p) => Math.log1p(k * p.conc)), ys);
  };
  const score = (lnK: number) => fitAt(lnK)?.r2 ?? -Infinity;
  const lo = Math.log(1e-3 / cMax);
  const hi = Math.log(1e3 / cMinPos);
  const N = 160;
  let bi = 0;
  let best = -Infinity;
  for (let i = 0; i <= N; i++) {
    const v = score(lo + ((hi - lo) * i) / N);
    if (v > best) {
      best = v;
      bi = i;
    }
  }
  // 황금분할 탐색으로 다듬기
  let a = lo + ((hi - lo) * Math.max(0, bi - 1)) / N;
  let b = lo + ((hi - lo) * Math.min(N, bi + 1)) / N;
  const g = (Math.sqrt(5) - 1) / 2;
  let x1 = b - g * (b - a);
  let x2 = a + g * (b - a);
  let f1 = score(x1);
  let f2 = score(x2);
  for (let it = 0; it < 60; it++) {
    if (f1 > f2) {
      b = x2;
      x2 = x1;
      f2 = f1;
      x1 = b - g * (b - a);
      f1 = score(x1);
    } else {
      a = x1;
      x1 = x2;
      f1 = f2;
      x2 = a + g * (b - a);
      f2 = score(x2);
    }
  }
  const lnK = (a + b) / 2;
  const fit = fitAt(lnK);
  if (!fit || fit.slope === 0) return null;
  return {
    model: 'szyszkowski',
    a: fit.intercept,
    b: fit.slope,
    k: Math.exp(lnK),
    r2: fit.r2,
    n: fit.n,
    cMin: Math.min(...used.map((p) => p.conc)),
    cMax,
  };
}

export function predictRatio(fit: CurveFit, conc: number): number {
  if (fit.model === 'szyszkowski') return conc >= 0 ? fit.a + fit.b * Math.log1p((fit.k ?? 0) * conc) : NaN;
  if (fit.model === 'log') return conc > 0 ? fit.a + fit.b * Math.log10(conc) : NaN;
  return fit.a + fit.b * conc;
}

export interface InverseResult {
  /** 역산 농도 (mg/L). 계산 불가면 null */
  conc: number | null;
  inRange: boolean;
  /** 'below' = 표준곡선 최저 농도보다 낮음, 'above' = 최고 농도보다 높음 */
  side: 'below' | 'above' | null;
}

/** v/v0 로부터 농도를 역산한다. 표준곡선 농도 범위 밖이면 inRange=false */
export function inverseConcentration(fit: CurveFit, ratio: number): InverseResult {
  if (!isFinite(ratio)) return { conc: null, inRange: false, side: null };
  const u = (ratio - fit.a) / fit.b;
  const conc = fit.model === 'log' ? Math.pow(10, u) : fit.model === 'szyszkowski' ? Math.expm1(u) / (fit.k ?? NaN) : u;
  if (!isFinite(conc)) return { conc: null, inRange: false, side: null };
  // 경계에 있는 표준용액이 반올림 오차로 '범위 밖'이 되지 않도록 범위의 2%까지는 안으로 봄
  const tol = 0.02 * Math.max(fit.cMax - fit.cMin, 1e-9);
  if (conc < fit.cMin - tol) return { conc, inRange: false, side: 'below' };
  if (conc > fit.cMax + tol) return { conc, inRange: false, side: 'above' };
  return { conc, inRange: true, side: null };
}

/**
 * 감도 S: 저농도 구간 [cLo, cHi] 점들로 그린 직선(v/v0 vs 농도)의 기울기.
 * 단위: (v/v0) / (mg/L)
 */
export function sensitivity(points: readonly StdPoint[], cLo: number, cHi: number): LinearFit | null {
  const lo = Math.min(cLo, cHi);
  const hi = Math.max(cLo, cHi);
  const used = points.filter((p) => p.conc >= lo - 1e-12 && p.conc <= hi + 1e-12);
  const distinct = new Set(used.map((p) => p.conc));
  if (distinct.size < 2) return null;
  return linearRegression(
    used.map((p) => p.conc),
    used.map((p) => p.ratio),
  );
}

export interface LodLoq {
  lod: number;
  loq: number;
}

/** LOD = 3σ0/|S|, LOQ = 10σ0/|S| */
export function lodLoq(sigma0: number, S: number): LodLoq | null {
  if (!isFinite(sigma0) || !isFinite(S) || S === 0 || sigma0 < 0) return null;
  return { lod: (3 * sigma0) / Math.abs(S), loq: (10 * sigma0) / Math.abs(S) };
}

export interface BlankStats {
  v0: number;
  /** 각 정제수 측정의 v/v0 */
  ratios: number[];
  /** σ0 = v/v0 의 표본 표준편차 */
  sigma0: number;
}

/** 정제수 속도 여러 개 → v0(중앙값), σ0 (최소 3개 필요) */
export function blankStats(blankSpeeds: readonly number[], minCount = 3): BlankStats | null {
  const v = blankSpeeds.filter((s) => isFinite(s) && s > 0);
  if (v.length < minCount) return null;
  const v0 = median(v);
  const ratios = v.map((s) => s / v0);
  return { v0, ratios, sigma0: sampleSD(ratios) };
}
