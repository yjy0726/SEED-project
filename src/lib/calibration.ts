import { linearRegression, type LinearFit } from './regression';
import { median, sampleSD } from './stats';

/** 표준곡선 점: 농도(mg/L)와 상대속도 v/v0 */
export interface StdPoint {
  conc: number;
  ratio: number;
}

/**
 * linear: v/v0 = a + b·c
 * log   : v/v0 = a + b·log10(c)   (c > 0 인 점만 사용)
 */
export type CurveModel = 'linear' | 'log';

export interface CurveFit {
  model: CurveModel;
  a: number;
  b: number;
  r2: number;
  n: number;
  /** 회귀에 쓴 농도 범위 */
  cMin: number;
  cMax: number;
}

export function fitStandardCurve(points: readonly StdPoint[], model: CurveModel): CurveFit | null {
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

export function predictRatio(fit: CurveFit, conc: number): number {
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
  const conc = fit.model === 'log' ? Math.pow(10, u) : u;
  if (!isFinite(conc)) return { conc: null, inRange: false, side: null };
  const tol = 1e-9 * Math.max(1, fit.cMax);
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
