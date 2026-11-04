/** 최소제곱 선형 회귀 y = slope·x + intercept */

export interface LinearFit {
  slope: number;
  intercept: number;
  /** 결정계수 R² (y 값이 모두 같으면 0) */
  r2: number;
  n: number;
}

/**
 * x[from..to) 범위의 점으로 선형 회귀를 한다.
 * 점이 2개 미만이거나 x가 모두 같으면 null.
 */
export function linearRegression(
  x: ArrayLike<number>,
  y: ArrayLike<number>,
  from = 0,
  to = x.length,
): LinearFit | null {
  const n = to - from;
  if (n < 2) return null;
  // 수치 안정성을 위해 평균을 먼저 구한 뒤 편차로 계산
  let sx = 0;
  let sy = 0;
  for (let i = from; i < to; i++) {
    sx += x[i];
    sy += y[i];
  }
  const mx = sx / n;
  const my = sy / n;
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (let i = from; i < to; i++) {
    const dx = x[i] - mx;
    const dy = y[i] - my;
    sxx += dx * dx;
    sxy += dx * dy;
    syy += dy * dy;
  }
  if (sxx === 0) return null;
  const slope = sxy / sxx;
  const intercept = my - slope * mx;
  const ssRes = syy - slope * sxy;
  const r2 = syy === 0 ? 0 : Math.max(0, Math.min(1, 1 - ssRes / syy));
  return { slope, intercept, r2, n };
}
