/**
 * 디코더가 준 밝기(Y) 평면에서 수로 영역만 줄여서 회색조 영상으로 뽑는다.
 * RGB 변환과 캔버스 그리기를 건너뛰어 훨씬 빠르다.
 */

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 화면(회전 적용) 좌표 → 원본 프레임 좌표 */
export function displayToCoded(X: number, Y: number, rot: number, W0: number, H0: number): [number, number] {
  switch (rot) {
    case 90:
      return [Y, H0 - X];
    case 180:
      return [W0 - X, H0 - Y];
    case 270:
      return [W0 - Y, X];
    default:
      return [X, Y];
  }
}

/** 화면 좌표의 사각형 → 원본 프레임에서 복사할 사각형 (짝수 정렬, 여유 2화소) */
export function codedRectFor(roi: Rect, rot: number, W0: number, H0: number): Rect {
  const corners = [
    displayToCoded(roi.x, roi.y, rot, W0, H0),
    displayToCoded(roi.x + roi.w, roi.y + roi.h, rot, W0, H0),
  ];
  let x0 = Math.min(corners[0][0], corners[1][0]) - 2;
  let y0 = Math.min(corners[0][1], corners[1][1]) - 2;
  let x1 = Math.max(corners[0][0], corners[1][0]) + 2;
  let y1 = Math.max(corners[0][1], corners[1][1]) + 2;
  x0 = Math.max(0, Math.floor(x0 / 2) * 2);
  y0 = Math.max(0, Math.floor(y0 / 2) * 2);
  x1 = Math.min(W0, Math.ceil(x1 / 2) * 2);
  y1 = Math.min(H0, Math.ceil(y1 / 2) * 2);
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/**
 * plane: 원본 좌표 (px0, py0) 에서 시작하는 pw×ph 밝기 평면 (stride = pw)
 * 출력: outW×outH 회색조 (화면 좌표의 roi 를 덮음). 작은 상자 평균으로 줄인다.
 * limitedRange: Y 값이 16~235 범위면 0~255 로 늘림
 */
export function sampleLuma(
  plane: Uint8Array,
  pw: number,
  ph: number,
  px0: number,
  py0: number,
  rot: number,
  W0: number,
  H0: number,
  roi: Rect,
  outW: number,
  outH: number,
  limitedRange = true,
  out?: Uint8Array,
): Uint8Array {
  const g = out ?? new Uint8Array(outW * outH);
  const fx = roi.w / outW;
  const fy = roi.h / outH;
  const k = Math.max(1, Math.min(3, Math.round(Math.max(fx, fy))));
  const lut = new Uint8Array(256);
  for (let v = 0; v < 256; v++) lut[v] = limitedRange ? Math.max(0, Math.min(255, Math.round(((v - 16) * 255) / 219))) : v;
  let o = 0;
  for (let v = 0; v < outH; v++) {
    for (let u = 0; u < outW; u++) {
      let sum = 0;
      let cnt = 0;
      for (let a = 0; a < k; a++) {
        const Y = roi.y + (v + (a + 0.5) / k) * fy;
        for (let b = 0; b < k; b++) {
          const X = roi.x + (u + (b + 0.5) / k) * fx;
          const [cx, cy] = displayToCoded(X, Y, rot, W0, H0);
          const ix = Math.floor(cx) - px0;
          const iy = Math.floor(cy) - py0;
          if (ix >= 0 && iy >= 0 && ix < pw && iy < ph) {
            sum += plane[iy * pw + ix];
            cnt++;
          }
        }
      }
      g[o++] = cnt ? lut[Math.round(sum / cnt)] : 0;
    }
  }
  return g;
}
