/**
 * 가상(합성) 데이터 생성기: 테스트와 '데모 불러오기'에 사용
 */

/** 재현 가능한 의사난수 (mulberry32) */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 표준정규분포 난수 (Box–Muller) */
export function gaussian(r: () => number): () => number {
  return () => {
    const u = Math.max(r(), 1e-12);
    const v = r();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
}

export interface MotionProfile {
  /** 등속 구간 속력 (mm/s) */
  v: number;
  /** 출발 시각 (s) – 그 전에는 정지 */
  tStart: number;
  /** 가속 시간 (s) */
  accel: number;
  /** 감속 시작 시각 (s) */
  tDecel: number;
  /** 감속 시간 (s) – 이후 정지 */
  decel: number;
}

export const DEFAULT_PROFILE: MotionProfile = { v: 20, tStart: 0.6, accel: 1.0, tDecel: 7.6, decel: 1.2 };

/** 위치(mm) – 정지 → 등가속 → 등속 → 등감속 → 정지 */
export function positionAt(p: MotionProfile, t: number): number {
  const a = p.v / p.accel;
  const d = p.v / p.decel;
  const t1 = p.tStart + p.accel;
  const xAccelEnd = 0.5 * a * p.accel ** 2;
  if (t <= p.tStart) return 0;
  if (t <= t1) return 0.5 * a * (t - p.tStart) ** 2;
  const xAtDecel = xAccelEnd + p.v * (p.tDecel - t1);
  if (t <= p.tDecel) return xAccelEnd + p.v * (t - t1);
  const td = Math.min(t - p.tDecel, p.decel);
  return xAtDecel + p.v * td - 0.5 * d * td * td;
}

/** 등속 구간의 실제 시작/끝 시각 */
export function constantInterval(p: MotionProfile): [number, number] {
  return [p.tStart + p.accel, p.tDecel];
}

/** 시간-위치 합성 데이터 (위치에 가우스 노이즈 noiseMm 추가) */
export function syntheticTrack(
  p: MotionProfile,
  fps = 30,
  duration = 10,
  noiseMm = 0.3,
  seed = 1,
): { t: number[]; x: number[] } {
  const g = gaussian(rng(seed));
  const t: number[] = [];
  const x: number[] = [];
  const n = Math.round(duration * fps);
  for (let i = 0; i < n; i++) {
    const ti = i / fps;
    t.push(ti);
    x.push(positionAt(p, ti) + noiseMm * g());
  }
  return { t, x };
}
