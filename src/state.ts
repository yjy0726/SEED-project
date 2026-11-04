import type { StdPoint, CurveModel } from './lib/calibration';
import type { Point } from './lib/tracking';
import type { FrameSource } from './source';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Sample {
  /** 영상 속 시간 (s) */
  t: number;
  /** 자동 추적 위치 (영상 화소 좌표) */
  auto: Point | null;
  autoArea: number;
  /** 사용자가 직접 찍은 위치 */
  manual: Point | null;
  excluded: boolean;
}

export interface TrackData {
  times: number[];
  frames: Uint8Array[];
  /** 작업 영상 크기 (수로 영역을 줄인 것) */
  w: number;
  h: number;
  /** 작업 영상을 만든 수로 영역 (영상 화소) */
  roi: Rect;
  bg: Uint8Array;
}

export type RecordKind = 'blank' | 'sample' | 'standard';

export interface RecordItem {
  id: string;
  name: string;
  kind: RecordKind;
  /** 표준용액 농도 (mg/L) */
  conc?: number;
  /** 속도 (mm/s) */
  v: number;
  /** 등속 구간 설명 */
  note?: string;
  createdAt: number;
}

export interface Persisted {
  records: RecordItem[];
  stdPoints: StdPoint[];
  curveModel: CurveModel;
  /** 표준곡선 그래프 가로축 로그 눈금 */
  logAxis?: boolean;
  sRange: [number, number] | null;
}

export const state = {
  source: null as FrameSource | null,
  frame: 0,
  fps: 30,
  ruler: { a: null as Point | null, b: null as Point | null, mm: null as number | null },
  roi: null as Rect | null,
  track: null as TrackData | null,
  threshold: 30,
  minArea: 6,
  samples: [] as Sample[],
  sampleIdx: 0,
  manualSegment: null as [number, number] | null,
  isDemo: false,
  data: {
    records: [],
    stdPoints: [],
    curveModel: 'szyszkowski',
    logAxis: false,
    sRange: null,
  } as Persisted,
};

export function frameCount(): number {
  const s = state.source;
  if (!s || !(state.fps > 0)) return 0;
  return Math.max(1, Math.floor(s.duration * state.fps + 1e-6));
}

export function pxPerMm(): number | null {
  const { a, b, mm } = state.ruler;
  if (!a || !b || !mm || !(mm > 0)) return null;
  const d = Math.hypot(b.x - a.x, b.y - a.y);
  return d > 0 ? d / mm : null;
}

/** 표본의 최종 위치: 직접 찍은 값 > 자동값, 제외하면 null */
export function samplePoint(s: Sample): Point | null {
  if (s.excluded) return null;
  return s.manual ?? s.auto;
}

// ───────── 이벤트 ─────────
type Listener = () => void;
const listeners = new Map<string, Set<Listener>>();
export function on(evt: string, fn: Listener) {
  if (!listeners.has(evt)) listeners.set(evt, new Set());
  listeners.get(evt)!.add(fn);
}
export function emit(evt: string) {
  listeners.get(evt)?.forEach((fn) => fn());
}

// ───────── 저장 (이 브라우저에만) ─────────
const KEY = 'camphor-boat-analyzer-v1';

export function loadPersisted() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return;
    const d = JSON.parse(raw) as Partial<Persisted>;
    if (Array.isArray(d.records)) state.data.records = d.records;
    if (Array.isArray(d.stdPoints)) state.data.stdPoints = d.stdPoints;
    if (d.curveModel === 'linear' || d.curveModel === 'log' || d.curveModel === 'szyszkowski') state.data.curveModel = d.curveModel;
    if (typeof d.logAxis === 'boolean') state.data.logAxis = d.logAxis;
    if (Array.isArray(d.sRange) && d.sRange.length === 2) state.data.sRange = d.sRange;
  } catch {
    /* 저장소를 못 쓰는 환경이면 무시 */
  }
}

export function savePersisted() {
  try {
    localStorage.setItem(KEY, JSON.stringify(state.data));
  } catch {
    /* 무시 */
  }
}

export function newId(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}
