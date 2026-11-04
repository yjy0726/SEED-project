/**
 * 보트 추적용 순수 영상 처리 함수 (DOM 없이 동작 → 단위 테스트 가능)
 * 모든 영상은 회색조 Uint8Array (가로 w × 세로 h) 로 다룬다.
 */

export function rgbaToGray(rgba: Uint8ClampedArray | Uint8Array, out?: Uint8Array): Uint8Array {
  const n = rgba.length >> 2;
  const g = out ?? new Uint8Array(n);
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    // ITU-R BT.601 근사 (정수 연산)
    g[i] = (rgba[j] * 77 + rgba[j + 1] * 150 + rgba[j + 2] * 29) >> 8;
  }
  return g;
}

/** 여러 프레임에서 고르게 maxSamples장을 뽑아 화소별 중앙값 → 배경 영상 */
export function medianBackground(frames: readonly Uint8Array[], maxSamples = 25): Uint8Array {
  if (frames.length === 0) throw new Error('프레임이 없어요.');
  const size = frames[0].length;
  const k = Math.min(maxSamples, frames.length);
  const picks: Uint8Array[] = [];
  for (let i = 0; i < k; i++) picks.push(frames[Math.round((i * (frames.length - 1)) / Math.max(1, k - 1))]);
  const bg = new Uint8Array(size);
  const hist = new Uint16Array(256);
  const half = k >> 1;
  for (let p = 0; p < size; p++) {
    hist.fill(0);
    for (let i = 0; i < k; i++) hist[picks[i][p]]++;
    let acc = 0;
    let v = 0;
    for (; v < 256; v++) {
      acc += hist[v];
      if (acc > half) break;
    }
    bg[p] = v;
  }
  return bg;
}

export interface Blob {
  /** 덩어리 중심 (작업 영상 좌표, 화소 중심 기준) */
  cx: number;
  cy: number;
  area: number;
}

/**
 * 배경 차분 + 임계값으로 가장 큰 덩어리를 찾는다.
 * mask 를 주면 결과를 기록: 0 = 배경, 1 = 임계값 넘음, 2 = 선택된 덩어리
 */
export function detectBlob(
  gray: Uint8Array,
  bg: Uint8Array,
  w: number,
  h: number,
  threshold: number,
  minArea = 4,
  mask?: Uint8Array,
): Blob | null {
  const n = w * h;
  const m = mask ?? new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const d = gray[i] - bg[i];
    m[i] = (d < 0 ? -d : d) >= threshold ? 1 : 0;
  }
  // 연결 요소 (4-이웃) 탐색, 가장 큰 덩어리 선택
  const label = new Int32Array(n);
  const stack = new Int32Array(n);
  let bestLabel = 0;
  let best: Blob | null = null;
  let cur = 0;
  for (let s = 0; s < n; s++) {
    if (m[s] !== 1 || label[s] !== 0) continue;
    cur++;
    let sp = 0;
    stack[sp++] = s;
    label[s] = cur;
    let area = 0;
    let sx = 0;
    let sy = 0;
    while (sp > 0) {
      const p = stack[--sp];
      const x = p % w;
      const y = (p - x) / w;
      area++;
      sx += x;
      sy += y;
      if (x > 0 && m[p - 1] === 1 && label[p - 1] === 0) { label[p - 1] = cur; stack[sp++] = p - 1; }
      if (x < w - 1 && m[p + 1] === 1 && label[p + 1] === 0) { label[p + 1] = cur; stack[sp++] = p + 1; }
      if (y > 0 && m[p - w] === 1 && label[p - w] === 0) { label[p - w] = cur; stack[sp++] = p - w; }
      if (y < h - 1 && m[p + w] === 1 && label[p + w] === 0) { label[p + w] = cur; stack[sp++] = p + w; }
    }
    if (area >= minArea && (!best || area > best.area)) {
      best = { cx: sx / area + 0.5, cy: sy / area + 0.5, area };
      bestLabel = cur;
    }
  }
  if (mask && bestLabel) for (let i = 0; i < n; i++) if (label[i] === bestLabel) mask[i] = 2;
  return best;
}

/** 오츠(Otsu) 방법으로 차이 영상의 임계값을 추천 */
export function suggestThreshold(frames: readonly Uint8Array[], bg: Uint8Array): number {
  const hist = new Float64Array(256);
  const step = Math.max(1, Math.floor(frames.length / 10));
  for (let f = 0; f < frames.length; f += step) {
    const g = frames[f];
    for (let i = 0; i < g.length; i++) hist[Math.abs(g[i] - bg[i])]++;
  }
  let total = 0;
  let sumAll = 0;
  for (let i = 0; i < 256; i++) {
    total += hist[i];
    sumAll += i * hist[i];
  }
  let wB = 0;
  let sumB = 0;
  let bestT = 30;
  let bestVar = -1;
  for (let t = 0; t < 255; t++) {
    wB += hist[t];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sumAll - sumB) / wF;
    const v = wB * wF * (mB - mF) ** 2;
    if (v > bestVar) {
      bestVar = v;
      bestT = t + 1;
    }
  }
  return Math.max(8, Math.min(120, bestT));
}

export interface Point {
  x: number;
  y: number;
}

/**
 * 화소 좌표 점들 → 이동 방향(처음→끝)으로 투영한 위치(mm).
 * 첫 유효 점을 0 mm 로 한다. null 인 점은 결과에서 NaN.
 */
export function projectToMm(points: readonly (Point | null)[], pxPerMm: number): number[] {
  const valid = points.filter((p): p is Point => !!p);
  if (valid.length === 0 || !(pxPerMm > 0)) return points.map(() => NaN);
  const p0 = valid[0];
  const p1 = valid[valid.length - 1];
  let ux = p1.x - p0.x;
  let uy = p1.y - p0.y;
  const len = Math.hypot(ux, uy);
  if (len < 1e-6) {
    ux = 1;
    uy = 0;
  } else {
    ux /= len;
    uy /= len;
  }
  return points.map((p) => (p ? ((p.x - p0.x) * ux + (p.y - p0.y) * uy) / pxPerMm : NaN));
}
