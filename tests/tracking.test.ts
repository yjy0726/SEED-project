import { describe, expect, it } from 'vitest';
import { detectBlob, medianBackground, projectToMm, rgbaToGray, suggestThreshold } from '../src/lib/tracking';
import { gaussian, rng } from '../src/lib/synthetic';

const W = 320;
const H = 80;

/** 어두운 수면 위를 밝은 보트(10×6 화소)가 지나가는 합성 프레임 */
function makeFrames(n: number, speedPxPerFrame: number, seed = 1) {
  const g = gaussian(rng(seed));
  const frames: Uint8Array[] = [];
  const truth: { x: number; y: number }[] = [];
  for (let f = 0; f < n; f++) {
    const img = new Uint8Array(W * H);
    for (let i = 0; i < img.length; i++) img[i] = Math.max(0, Math.min(255, 70 + 4 * g()));
    const bx = 20 + f * speedPxPerFrame;
    const by = 37;
    for (let y = by; y < by + 6; y++) for (let x = Math.floor(bx); x < Math.floor(bx) + 10; x++) if (x < W) img[y * W + x] = 220;
    frames.push(img);
    truth.push({ x: Math.floor(bx) + 5, y: by + 3 });
  }
  return { frames, truth };
}

describe('보트 추적 (배경 차분)', () => {
  it('회색조 변환', () => {
    const g = rgbaToGray(new Uint8ClampedArray([255, 255, 255, 255, 0, 0, 0, 255]));
    expect(g[0]).toBeGreaterThan(250);
    expect(g[1]).toBe(0);
  });

  it('중앙값 배경에는 움직이는 보트가 남지 않음', () => {
    const { frames } = makeFrames(60, 4);
    const bg = medianBackground(frames);
    let max = 0;
    for (const v of bg) max = Math.max(max, v);
    expect(max).toBeLessThan(120);
  });

  it('보트 중심을 1화소 안에서 찾음 + 마스크 기록', () => {
    const { frames, truth } = makeFrames(60, 4);
    const bg = medianBackground(frames);
    const mask = new Uint8Array(W * H);
    for (const f of [5, 30, 55]) {
      const b = detectBlob(frames[f], bg, W, H, 40, 4, mask)!;
      expect(Math.abs(b.cx - truth[f].x)).toBeLessThan(1);
      expect(Math.abs(b.cy - truth[f].y)).toBeLessThan(1);
      expect(b.area).toBe(60);
    }
    expect(mask.some((v) => v === 2)).toBe(true);
  });

  it('임계값이 너무 높으면 못 찾음 (null)', () => {
    const { frames } = makeFrames(20, 4);
    const bg = medianBackground(frames);
    expect(detectBlob(frames[3], bg, W, H, 250)).toBeNull();
  });

  it('추천 임계값은 노이즈보다 크고 보트 밝기 차이보다 작음', () => {
    const { frames } = makeFrames(60, 4);
    const bg = medianBackground(frames);
    const t = suggestThreshold(frames, bg);
    expect(t).toBeGreaterThan(12);
    expect(t).toBeLessThan(150);
  });

  it('성능: 300프레임(10초×30fps) 배경 계산 + 추적이 1초 안에 끝남', () => {
    const { frames } = makeFrames(300, 0.9);
    const t0 = performance.now();
    const bg = medianBackground(frames);
    const mask = new Uint8Array(W * H);
    let found = 0;
    for (const f of frames) if (detectBlob(f, bg, W, H, 40, 4, mask)) found++;
    const ms = performance.now() - t0;
    expect(found).toBeGreaterThan(290);
    expect(ms).toBeLessThan(1000);
  });

  it('화소 좌표 → 이동 방향 투영 위치(mm)', () => {
    const pts = [{ x: 10, y: 10 }, null, { x: 13, y: 14 }, { x: 16, y: 18 }];
    const mm = projectToMm(pts, 2);
    expect(mm[0]).toBe(0);
    expect(mm[1]).toBeNaN();
    expect(mm[2]).toBeCloseTo(2.5, 10);
    expect(mm[3]).toBeCloseTo(5, 10);
  });
});
