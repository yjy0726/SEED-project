import { describe, expect, it } from 'vitest';
import { detectConstantVelocity, segmentFromTimes } from '../src/lib/constantVelocity';
import { constantInterval, gaussian, rng, syntheticTrack, type MotionProfile } from '../src/lib/synthetic';

describe('등속 구간 탐지 – 가상 데이터', () => {
  // 상대 노이즈 = 노이즈 / (0.5초 동안 이동 거리)
  type Case = { name: string; p: MotionProfile; fps: number; noise: number };
  const realistic: Case[] = [
    { name: 'v=20 mm/s, 30 fps, 노이즈 0.3 mm', p: { v: 20, tStart: 0.6, accel: 1.0, tDecel: 7.6, decel: 1.2 }, fps: 30, noise: 0.3 },
    { name: 'v=8 mm/s (느린 보트), 30 fps, 노이즈 0.08 mm', p: { v: 8, tStart: 0.5, accel: 1.5, tDecel: 8, decel: 1 }, fps: 30, noise: 0.08 },
    { name: 'v=35 mm/s, 60 fps, 노이즈 0.5 mm', p: { v: 35, tStart: 1, accel: 0.8, tDecel: 6.5, decel: 1.5 }, fps: 60, noise: 0.5 },
    { name: 'v=15 mm/s, 15 fps(프레임 누락), 노이즈 0.15 mm', p: { v: 15, tStart: 0.4, accel: 1, tDecel: 8.5, decel: 1 }, fps: 15, noise: 0.15 },
  ];
  const noisy: Case[] = [
    { name: 'v=8 mm/s, 30 fps, 큰 노이즈 0.2 mm', p: { v: 8, tStart: 0.5, accel: 1.5, tDecel: 8, decel: 1 }, fps: 30, noise: 0.2 },
    { name: 'v=15 mm/s, 15 fps, 큰 노이즈 0.3 mm', p: { v: 15, tStart: 0.4, accel: 1, tDecel: 8.5, decel: 1 }, fps: 15, noise: 0.3 },
  ];
  const seeds = Array.from({ length: 10 }, (_, i) => i + 1);

  for (const c of realistic) {
    it(`${c.name}: 10개 seed 모두 속도 ±3%, 구간이 실제 등속 구간과 일치`, () => {
      const [a, b] = constantInterval(c.p);
      for (const seed of seeds) {
        const { t, x } = syntheticTrack(c.p, c.fps, 10, c.noise, seed);
        const s = detectConstantVelocity(t, x).segment;
        expect(s, `seed ${seed}`).not.toBeNull();
        expect(Math.abs(s!.speed - c.p.v) / c.p.v, `seed ${seed} 속도 오차`).toBeLessThan(0.03);
        // 가장자리는 창 길이(0.5초)만큼 허용
        expect(s!.tStart, `seed ${seed} 시작`).toBeGreaterThan(a - 0.5);
        expect(s!.tEnd, `seed ${seed} 끝`).toBeLessThan(b + 0.5);
        expect(s!.tEnd - s!.tStart, `seed ${seed} 길이`).toBeGreaterThan(0.6 * (b - a));
        expect(s!.fit.r2).toBeGreaterThanOrEqual(0.98);
      }
    });
  }

  for (const c of noisy) {
    it(`${c.name}: 구간은 짧아질 수 있지만 속도는 ±3%`, () => {
      const [a, b] = constantInterval(c.p);
      for (const seed of seeds) {
        const { t, x } = syntheticTrack(c.p, c.fps, 10, c.noise, seed);
        const s = detectConstantVelocity(t, x).segment;
        expect(s, `seed ${seed}`).not.toBeNull();
        expect(Math.abs(s!.speed - c.p.v) / c.p.v).toBeLessThan(0.03);
        expect(s!.tStart).toBeGreaterThan(a - 0.5);
        expect(s!.tEnd).toBeLessThan(b + 0.5);
      }
    });
  }

  it('뒤로 움직이는 보트(위치가 감소)도 속력은 양수', () => {
    const p: MotionProfile = { v: 20, tStart: 0.6, accel: 1, tDecel: 7.6, decel: 1.2 };
    const { t, x } = syntheticTrack(p, 30, 10, 0.3, 7);
    const neg = x.map((v) => -v);
    const { segment } = detectConstantVelocity(t, neg);
    expect(segment!.fit.slope).toBeLessThan(0);
    expect(Math.abs(segment!.speed - 20) / 20).toBeLessThan(0.03);
  });

  it('계속 가속하는 움직임이면 등속 구간 없음', () => {
    const t: number[] = [];
    const x: number[] = [];
    for (let i = 0; i < 300; i++) {
      const ti = i / 30;
      t.push(ti);
      x.push(0.5 * 12 * ti * ti * ti); // 가가속 (기울기가 계속 변함)
    }
    // 0.5초 창의 기울기는 계속 변하므로 ±10% 묶음이 매우 짧아야 함
    const { segment } = detectConstantVelocity(t, x);
    if (segment) expect(segment.tEnd - segment.tStart).toBeLessThan(1.5);
  });

  it('정지한 보트(노이즈만 있음)는 등속 구간 없음', () => {
    const g = gaussian(rng(3));
    const t = Array.from({ length: 300 }, (_, i) => i / 30);
    const x = t.map(() => 0.3 * g());
    expect(detectConstantVelocity(t, x).segment).toBeNull();
  });

  it('점이 너무 적으면 null', () => {
    expect(detectConstantVelocity([0, 0.1], [0, 1]).segment).toBeNull();
  });

  it('수동 구간 선택', () => {
    const t = Array.from({ length: 100 }, (_, i) => i / 10);
    const x = t.map((v) => 5 * v + 1);
    const s = segmentFromTimes(t, x, 6, 2)!;
    expect(s.tStart).toBeCloseTo(2, 9);
    expect(s.tEnd).toBeCloseTo(6, 9);
    expect(s.speed).toBeCloseTo(5, 9);
    expect(segmentFromTimes(t, x, 2, 2.1)).toBeNull();
  });
});
