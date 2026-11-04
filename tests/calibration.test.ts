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

describe('표준곡선 – 표면장력(시슈코프스키) 모형 v/v0 = a + b·ln(1 + k·c)', () => {
  const concs = [0, 0, 0, 0.5, 0.5, 1, 1, 2, 2, 5, 5, 10, 10];
  const model = (c: number) => 1 - 0.3 * Math.log1p(0.9 * c);

  it('정확한 데이터에서 a, b, k 를 되찾음 (0 mg/L 점도 사용)', () => {
    const f = fitStandardCurve(concs.map((c) => ({ conc: c, ratio: model(c) })), 'szyszkowski')!;
    expect(f.a).toBeCloseTo(1, 4);
    expect(f.b).toBeCloseTo(-0.3, 4);
    expect(f.k!).toBeCloseTo(0.9, 3);
    expect(f.r2).toBeCloseTo(1, 8);
    expect(f.n).toBe(13);
    expect(f.cMin).toBe(0);
    expect(predictRatio(f, 3)).toBeCloseTo(model(3), 6);
    const inv = inverseConcentration(f, model(3));
    expect(inv.conc!).toBeCloseTo(3, 4);
    expect(inv.inRange).toBe(true);
    expect(inverseConcentration(f, model(15)).side).toBe('above');
  });

  it('곡선 데이터(v/v0 = 1/(1+c/4))에서 선형·로그 모형보다 역산 오차가 훨씬 작음', () => {
    const truth = (c: number) => 1 / (1 + c / 4);
    const pts = concs.map((c) => ({ conc: c, ratio: truth(c) }));
    const maxErr = (m: 'linear' | 'log' | 'szyszkowski') => {
      const f = fitStandardCurve(pts, m)!;
      return Math.max(...[0.5, 1, 2, 5, 10].map((c) => Math.abs(inverseConcentration(f, truth(c)).conc! / c - 1)));
    };
    const sz = maxErr('szyszkowski');
    expect(sz).toBeLessThan(0.1);
    expect(sz).toBeLessThan(maxErr('log') / 2);
    expect(sz).toBeLessThan(maxErr('linear') / 2);
  });

  it('노이즈가 있어도 역산 농도가 ±10% 안 (중간 농도)', () => {
    let seed = 7;
    const r = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 0.02; // ±1%
    const pts = concs.map((c) => ({ conc: c, ratio: model(c) * (1 + r()) }));
    const f = fitStandardCurve(pts, 'szyszkowski')!;
    for (const c of [1, 2, 5]) expect(Math.abs(inverseConcentration(f, model(c)).conc! / c - 1)).toBeLessThan(0.1);
  });

  it('서로 다른 농도가 3개 미만이면 null', () => {
    expect(fitStandardCurve([{ conc: 0, ratio: 1 }, { conc: 1, ratio: 0.8 }, { conc: 1, ratio: 0.81 }], 'szyszkowski')).toBeNull();
  });
});
