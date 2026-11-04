import { describe, expect, it } from 'vitest';
import { codedRectFor, displayToCoded, sampleLuma } from '../src/lib/luma';

/** 원본 프레임 W0×H0 에 밝은 점 하나 (cx, cy) */
function frameWithDot(W0: number, H0: number, cx: number, cy: number) {
  const p = new Uint8Array(W0 * H0).fill(16);
  for (let y = cy - 2; y <= cy + 2; y++) for (let x = cx - 2; x <= cx + 2; x++) p[y * W0 + x] = 235;
  return p;
}

function brightest(g: Uint8Array, w: number) {
  let best = -1;
  let bi = 0;
  g.forEach((v, i) => { if (v > best) { best = v; bi = i; } });
  return { x: bi % w, y: Math.floor(bi / w), v: best };
}

describe('밝기 평면 샘플링 (빠른 디코더 경로)', () => {
  const W0 = 200;
  const H0 = 100;
  const plane = frameWithDot(W0, H0, 150, 30);

  it('회전 없음: 점이 같은 자리, 16~235 → 0~255', () => {
    const roi = { x: 0, y: 0, w: 200, h: 100 };
    const g = sampleLuma(plane, W0, H0, 0, 0, 0, W0, H0, roi, 200, 100);
    const b = brightest(g, 200);
    expect(b).toEqual({ x: 148, y: 28, v: 255 });
    expect(g[0]).toBe(0);
  });

  for (const rot of [90, 180, 270]) {
    it(`${rot}° 회전: 화면 좌표의 점 위치가 회전 공식과 일치`, () => {
      const sideways = rot % 180 !== 0;
      const DW = sideways ? H0 : W0;
      const DH = sideways ? W0 : H0;
      const roi = { x: 0, y: 0, w: DW, h: DH };
      const g = sampleLuma(plane, W0, H0, 0, 0, rot, W0, H0, roi, DW, DH);
      // 화면에서 밝은 점의 중심
      let sx = 0, sy = 0, n = 0;
      g.forEach((v, i) => { if (v > 200) { sx += i % DW; sy += Math.floor(i / DW); n++; } });
      const [cx, cy] = displayToCoded(sx / n + 0.5, sy / n + 0.5, rot, W0, H0);
      expect(cx).toBeCloseTo(150.5, 0);
      expect(cy).toBeCloseTo(30.5, 0);
    });
  }

  it('일부 영역만 복사한 평면 + 축소', () => {
    const roi = { x: 100, y: 10, w: 100, h: 40 };
    const r = codedRectFor(roi, 0, W0, H0);
    expect(r.x % 2).toBe(0);
    expect(r.y % 2).toBe(0);
    const sub = new Uint8Array(r.w * r.h);
    for (let y = 0; y < r.h; y++) for (let x = 0; x < r.w; x++) sub[y * r.w + x] = plane[(y + r.y) * W0 + x + r.x];
    const g = sampleLuma(sub, r.w, r.h, r.x, r.y, 0, W0, H0, roi, 50, 20);
    const b = brightest(g, 50);
    // (150,30) → 출력 ((150-100)/2, (30-10)/2) = (25, 10) 근처
    expect(Math.abs(b.x - 25)).toBeLessThanOrEqual(1);
    expect(Math.abs(b.y - 10)).toBeLessThanOrEqual(1);
  });
});
