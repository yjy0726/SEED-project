import { describe, expect, it } from 'vitest';
import { mean, median, rsdPercent, sampleSD } from '../src/lib/stats';
import { linearRegression } from '../src/lib/regression';

describe('통계', () => {
  it('평균·중앙값·표본표준편차·RSD', () => {
    expect(mean([1, 2, 3, 4])).toBe(2.5);
    expect(median([5, 1, 3])).toBe(3);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(sampleSD([2, 4, 4, 4, 5, 5, 7, 9])).toBeCloseTo(2.13809, 4);
    expect(rsdPercent([9, 10, 11])).toBeCloseTo(10, 6);
    expect(sampleSD([1])).toBeNaN();
    expect(mean([])).toBeNaN();
  });
});

describe('선형 회귀', () => {
  it('정확한 직선이면 기울기·절편을 그대로, R²=1', () => {
    const x = [0, 1, 2, 3, 4];
    const y = x.map((v) => 3 * v - 2);
    const f = linearRegression(x, y)!;
    expect(f.slope).toBeCloseTo(3, 12);
    expect(f.intercept).toBeCloseTo(-2, 12);
    expect(f.r2).toBeCloseTo(1, 12);
    expect(f.n).toBe(5);
  });
  it('알려진 예제의 R²', () => {
    const f = linearRegression([1, 2, 3, 4, 5], [2, 4, 5, 4, 5])!;
    expect(f.slope).toBeCloseTo(0.6, 10);
    expect(f.intercept).toBeCloseTo(2.2, 10);
    expect(f.r2).toBeCloseTo(0.6, 10);
  });
  it('부분 범위 [from, to)', () => {
    const f = linearRegression([0, 1, 2, 3], [9, 1, 2, 3], 1, 4)!;
    expect(f.slope).toBeCloseTo(1, 12);
  });
  it('점이 부족하거나 x가 모두 같으면 null', () => {
    expect(linearRegression([1], [1])).toBeNull();
    expect(linearRegression([2, 2, 2], [1, 2, 3])).toBeNull();
  });
});
