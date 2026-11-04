import { DEMO, DemoSource } from './source';
import { newId, savePersisted, state, type RecordItem, type RecordKind } from './state';
import { setSource } from './ui/step1';
import { $, askConfirm } from './ui/dom';

/**
 * 데모 측정 기록 (가상 데이터).
 * 가정한 관계: v/v0 ≈ 1 / (1 + c/4)  (c: LAS 농도 mg/L), 정제수 v0 ≈ 25 mm/s, 측정 오차 약 ±1.5%
 */
const DEMO_RECORDS: [string, RecordKind, number | undefined, number][] = [
  ['정제수', 'blank', undefined, 25.02],
  ['정제수', 'blank', undefined, 24.61],
  ['정제수', 'blank', undefined, 25.43],
  ['LAS 0.5 mg/L', 'standard', 0.5, 22.4],
  ['LAS 0.5 mg/L', 'standard', 0.5, 22.0],
  ['LAS 1 mg/L', 'standard', 1, 20.2],
  ['LAS 1 mg/L', 'standard', 1, 19.7],
  ['LAS 2 mg/L', 'standard', 2, 16.9],
  ['LAS 2 mg/L', 'standard', 2, 16.4],
  ['LAS 5 mg/L', 'standard', 5, 11.3],
  ['LAS 5 mg/L', 'standard', 5, 10.9],
  ['LAS 10 mg/L', 'standard', 10, 7.3],
  ['LAS 10 mg/L', 'standard', 10, 7.0],
  ['하천수 A', 'sample', undefined, 18.1],
  ['하천수 A', 'sample', undefined, 18.7],
  ['생활하수 B', 'sample', undefined, 9.6],
  ['생활하수 B', 'sample', undefined, 9.9],
  ['생활하수 B', 'sample', undefined, 9.4],
  ['수돗물 C', 'sample', undefined, 24.7],
  ['수돗물 C', 'sample', undefined, 24.9],
  ['수돗물 C', 'sample', undefined, 25.2],
];

export async function loadDemo() {
  const src = new DemoSource();
  setSource(src, DEMO.fps, true);
  $('fileName').textContent = `${src.name} · ${src.width}×${src.height} 화소 · ${src.duration.toFixed(2)}초`;
  // 축척: 자의 0 mm 와 250 mm 눈금, 수로 영역: 물길 전체
  state.ruler = {
    a: { x: DEMO.ruler0, y: DEMO.rulerY - 10 },
    b: { x: DEMO.ruler0 + 250 * DEMO.pxPerMm, y: DEMO.rulerY - 10 },
    mm: 250,
  };
  const ch = DEMO.channel;
  state.roi = { x: ch.x, y: ch.y, w: ch.w, h: ch.h };

  const hasData = state.data.records.length > 0 || state.data.stdPoints.length > 0;
  const replace =
    !hasData ||
    (await askConfirm('지금 있는 측정 기록과 표준곡선을 데모 예시로 바꿀까요?\n‘영상만’을 누르면 데모 영상만 불러오고 기록은 그대로 둬요.', '예시로 바꾸기', '영상만'));
  if (replace) {
    const now = Date.now();
    state.data.records = DEMO_RECORDS.map(
      ([name, kind, conc, v], i): RecordItem => ({ id: newId(), name, kind, v, createdAt: now - (DEMO_RECORDS.length - i) * 60000, ...(conc !== undefined ? { conc } : {}) }),
    );
    state.data.stdPoints = [];
    state.data.curveModel = 'log';
    state.data.sRange = [0, 2];
    savePersisted();
  }
}
