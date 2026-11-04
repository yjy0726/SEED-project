import { projectToMm } from './lib/tracking';
import { pxPerMm, samplePoint, state } from './state';

export interface PositionSeries {
  /** 시간 (s) */
  t: number[];
  /** 이동 방향 위치 (mm) */
  x: number[];
  /** 원래 표본 번호 */
  idx: number[];
  manual: boolean[];
}

/** 추적 결과 → 유효한 점만 모은 시간-위치 데이터 */
export function positionSeries(): PositionSeries {
  const k = pxPerMm();
  const out: PositionSeries = { t: [], x: [], idx: [], manual: [] };
  if (!k || state.samples.length === 0) return out;
  const pts = state.samples.map(samplePoint);
  const mm = projectToMm(pts, k);
  state.samples.forEach((s, i) => {
    if (!isFinite(mm[i])) return;
    out.t.push(s.t);
    out.x.push(mm[i]);
    out.idx.push(i);
    out.manual.push(!!s.manual && !s.excluded);
  });
  return out;
}
