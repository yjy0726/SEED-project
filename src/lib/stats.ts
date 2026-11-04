/** 기본 통계 함수 모음 */

export function mean(values: readonly number[]): number {
  if (values.length === 0) return NaN;
  let s = 0;
  for (const v of values) s += v;
  return s / values.length;
}

/** 표본 표준편차 (n-1로 나눔). 값이 2개 미만이면 NaN */
export function sampleSD(values: readonly number[]): number {
  const n = values.length;
  if (n < 2) return NaN;
  const m = mean(values);
  let ss = 0;
  for (const v of values) ss += (v - m) ** 2;
  return Math.sqrt(ss / (n - 1));
}

export function median(values: readonly number[]): number {
  if (values.length === 0) return NaN;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** 상대표준편차(%) = SD / 평균 × 100 */
export function rsdPercent(values: readonly number[]): number {
  const m = mean(values);
  const sd = sampleSD(values);
  if (!isFinite(sd) || m === 0) return NaN;
  return (Math.abs(sd) / Math.abs(m)) * 100;
}
