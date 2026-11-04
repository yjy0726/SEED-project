import { describe, expect, it } from 'vitest';
import {
  blankStats,
  fitStandardCurve,
  inverseConcentration,
  lodLoq,
  predictRatio,
  sensitivity,
  type StdPoint,
} from '../src/lib/calibration';

describe('표준곡선 – 선형 모델', () => {
  const pts: StdPoint[] = [0, 1, 2, 3, 4].map((c) => ({ conc: c, ratio: 1 - 0.1 * c }));
  const fit = fitStandardCurve(pts, 'linear')!;
  it('기울기·절편', () => {
    expect(fit.a).toBeCloseTo(1, 10);
    expect(fit.b).toBeCloseTo(-0.1, 10);
    expect(fit.r2).toBeCloseTo(1, 10);
    expect(predictRatio(fit, 2.5)).toBeCloseTo(0.75, 10);
  });
  it('역산', () => {
    const r = inverseConcentration(fit, 0.75);
    expect(r.conc).toBeCloseTo(2.5, 10);
    expect(r.inRange).toBe(true);
  });
  it('범위 밖', () => {
    const hi = inverseConcentration(fit, 0.4); // 6 mg/L
    expect(hi.inRange).toBe(false);
    expect(hi.side).toBe('above');
    const lo = inverseConcentration(fit, 1.05); // -0.5 mg/L
    expect(lo.inRange).toBe(false);
    expect(lo.side).toBe('below');
  });
});

describe('표준곡선 – 로그 농도 모델', () => {
  // v/v0 = 0.8 - 0.3·log10(c)
  const pts: StdPoint[] = [0, 0.5, 1, 2, 5, 10].map((c) => ({ conc: c, ratio: c > 0 ? 0.8 - 0.3 * Math.log10(c) : 1 }));
  const fit = fitStandardCurve(pts, 'log')!;
  it('0 mg/L 점은 제외하고 맞춤', () => {
    expect(fit.n).toBe(5);
    expect(fit.a).toBeCloseTo(0.8, 10);
    expect(fit.b).toBeCloseTo(-0.3, 10);
    expect(fit.cMin).toBe(0.5);
  });
  it('역산', () => {
    const r = inverseConcentration(fit, 0.8 - 0.3 * Math.log10(3));
    expect(r.conc).toBeCloseTo(3, 8);
    expect(r.inRange).toBe(true);
    expect(inverseConcentration(fit, 0.99).inRange).toBe(false);
  });
  it('점이 부족하면 null', () => {
    expect(fitStandardCurve([{ conc: 0, ratio: 1 }, { conc: 1, ratio: 0.9 }], 'log')).toBeNull();
  });
});

describe('감도 S, LOD, LOQ', () => {
  const pts: StdPoint[] = [
    { conc: 0, ratio: 1 }, { conc: 0, ratio: 1.0 },
    { conc: 0.5, ratio: 0.95 }, { conc: 1, ratio: 0.9 }, { conc: 2, ratio: 0.8 },
    { conc: 10, ratio: 0.3 },
  ];
  it('선택한 저농도 범위로만 S 계산', () => {
    const s = sensitivity(pts, 0, 2)!;
    expect(s.slope).toBeCloseTo(-0.1, 10);
    expect(sensitivity(pts, 0.5, 0.5)).toBeNull();
  });
  it('LOD = 3σ0/|S|, LOQ = 10σ0/|S|', () => {
    const r = lodLoq(0.02, -0.1)!;
    expect(r.lod).toBeCloseTo(0.6, 10);
    expect(r.loq).toBeCloseTo(2, 10);
    expect(lodLoq(0.02, 0)).toBeNull();
    expect(lodLoq(NaN, -0.1)).toBeNull();
  });
  it('정제수 3개 이상 → v0 = 중앙값, σ0 = v/v0 표준편차', () => {
    const b = blankStats([24, 25, 26])!;
    expect(b.v0).toBe(25);
    expect(b.ratios).toEqual([0.96, 1, 1.04]);
    expect(b.sigma0).toBeCloseTo(0.04, 10);
    expect(blankStats([24, 25])).toBeNull();
  });
});
