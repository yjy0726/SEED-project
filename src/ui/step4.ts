import {
  blankStats,
  fitStandardCurve,
  inverseConcentration,
  lodLoq,
  predictRatio,
  sensitivity,
  type CurveFit,
  type CurveModel,
  type StdPoint,
} from '../lib/calibration';
import { detectConstantVelocity, segmentFromTimes, type Segment } from '../lib/constantVelocity';
import { parseStandardCSV, toCSV } from '../lib/csv';
import { mean, rsdPercent, sampleSD } from '../lib/stats';
import { positionSeries, type PositionSeries } from '../series';
import { newId, on, savePersisted, state, type RecordItem, type RecordKind } from '../state';
import { axis, C, makeChart, type Chart } from './charts';
import { $, askConfirm, download, esc, fmt, fmtConc, hideMsg, parseNum, showMsg, toast } from './dom';

let chart4: Chart | null = null;
let chart5: Chart | null = null;
let series: PositionSeries = { t: [], x: [], idx: [], manual: [] };
let segment: Segment | null = null;
let autoFailed = false;
let picks: number[] = [];

const KIND_LABEL: Record<RecordKind, string> = { blank: '정제수', sample: '시료', standard: '표준용액' };

// ───────────── 파생 계산 ─────────────
interface Derived {
  v0: number | null;
  blankRatios: number[];
  sigma0: number | null;
  sigmaSource: string;
  stdAll: (StdPoint & { source: string; manualIndex?: number })[];
  fit: CurveFit | null;
  S: ReturnType<typeof sensitivity>;
  sRange: [number, number] | null;
  lod: number | null;
  loq: number | null;
}

function derive(): Derived {
  const d = state.data;
  const blanks = d.records.filter((r) => r.kind === 'blank');
  const bs = blankStats(blanks.map((r) => r.v));
  const v0 = bs?.v0 ?? null;
  const stdAll: Derived['stdAll'] = d.stdPoints.map((p, i) => ({ ...p, source: '직접 입력', manualIndex: i }));
  if (v0) {
    for (const r of d.records) {
      if (r.kind === 'standard' && r.conc !== undefined) stdAll.push({ conc: r.conc, ratio: r.v / v0, source: `기록: ${r.name}` });
      if (r.kind === 'blank') stdAll.push({ conc: 0, ratio: r.v / v0, source: `기록: ${r.name}` });
    }
  }
  stdAll.sort((a, b) => a.conc - b.conc);

  // σ0: 정제수 기록 3개 이상이면 그것, 아니면 표준곡선의 0 mg/L 점 3개 이상
  let sigma0: number | null = null;
  let sigmaSource = '';
  if (bs && isFinite(bs.sigma0)) {
    sigma0 = bs.sigma0;
    sigmaSource = `정제수 기록 ${bs.ratios.length}개`;
  } else {
    const zeros = stdAll.filter((p) => p.conc === 0).map((p) => p.ratio);
    if (zeros.length >= 3) {
      sigma0 = sampleSD(zeros);
      sigmaSource = `표준곡선의 0 mg/L 점 ${zeros.length}개`;
    }
  }

  const fit = fitStandardCurve(stdAll, d.curveModel);
  const concs = [...new Set(stdAll.map((p) => p.conc))].sort((a, b) => a - b);
  let sRange: [number, number] | null = null;
  if (concs.length >= 2) {
    const saved = d.sRange;
    if (saved && concs.includes(saved[0]) && concs.includes(saved[1]) && saved[0] < saved[1]) sRange = saved;
    else sRange = [concs[0], concs[Math.min(concs.length - 1, 3)]];
  }
  const S = sRange ? sensitivity(stdAll, sRange[0], sRange[1]) : null;
  const ll = sigma0 !== null && S ? lodLoq(sigma0, S.slope) : null;
  return {
    v0,
    blankRatios: bs?.ratios ?? [],
    sigma0,
    sigmaSource,
    stdAll,
    fit,
    S,
    sRange,
    lod: ll?.lod ?? null,
    loq: ll?.loq ?? null,
  };
}

function estimate(dv: Derived, ratio: number): { conc: number | null; notes: string[] } {
  if (!dv.fit || !isFinite(ratio)) return { conc: null, notes: dv.fit ? [] : ['표준곡선 없음'] };
  const r = inverseConcentration(dv.fit, ratio);
  const notes: string[] = [];
  if (!r.inRange) notes.push(r.side === 'below' ? '범위 밖 (표준곡선 최저 농도보다 낮음)' : '범위 밖 (표준곡선 최고 농도보다 높음)');
  if (r.conc !== null && dv.lod !== null && r.conc < dv.lod) notes.push('감지한계 미만');
  else if (r.conc !== null && dv.loq !== null && r.conc < dv.loq) notes.push('정량한계 미만 (참고값)');
  return { conc: r.conc, notes };
}

// ───────────── 초기화 ─────────────
export function initStep4() {
  const kind = $<HTMLSelectElement>('recKind');
  kind.addEventListener('change', () => ($('recConcWrap').hidden = kind.value !== 'standard'));
  $('btnSave').addEventListener('click', saveRecord);

  $('btnSegApply').addEventListener('click', () => {
    const a = parseNum($<HTMLInputElement>('segStart'));
    const b = parseNum($<HTMLInputElement>('segEnd'));
    if (!isFinite(a) || !isFinite(b) || Math.abs(b - a) < 0.1) {
      showMsg($('msg4'), '시작과 끝 시간을 숫자로 넣어 주세요. 두 시간은 0.1초 이상 떨어져야 해요.', 'warn');
      return;
    }
    state.manualSegment = [Math.min(a, b), Math.max(a, b)];
    hideMsg($('msg4'));
    renderVelocity(true);
  });
  $('btnSegAuto').addEventListener('click', () => {
    state.manualSegment = null;
    picks = [];
    renderVelocity(true);
  });

  const model = $<HTMLSelectElement>('curveModel');
  model.value = state.data.curveModel;
  model.addEventListener('change', () => {
    state.data.curveModel = model.value as CurveModel;
    savePersisted();
    renderData();
  });

  $('btnStdAdd').addEventListener('click', () => {
    const c = parseNum($<HTMLInputElement>('stdC'));
    const r = parseNum($<HTMLInputElement>('stdR'));
    if (!(c >= 0) || !(r > 0)) {
      showMsg($('msg4'), '표준곡선 점은 농도(0 이상)와 v/v₀(0보다 큰 수)를 모두 숫자로 넣어 주세요.', 'warn');
      return;
    }
    hideMsg($('msg4'));
    state.data.stdPoints.push({ conc: c, ratio: r });
    savePersisted();
    $<HTMLInputElement>('stdC').value = '';
    $<HTMLInputElement>('stdR').value = '';
    renderData();
  });
  $<HTMLInputElement>('stdFile').addEventListener('change', async (e) => {
    const input = e.target as HTMLInputElement;
    const f = input.files?.[0];
    input.value = '';
    if (!f) return;
    const { points, skipped } = parseStandardCSV(await f.text());
    if (points.length === 0) {
      showMsg($('msg4'), 'CSV에서 숫자 점을 찾지 못했어요. 첫째 열은 농도(mg/L), 둘째 열은 v/v₀ 로 적어 주세요.', 'err');
      return;
    }
    state.data.stdPoints.push(...points);
    savePersisted();
    renderData();
    showMsg($('msg4'), `표준곡선 점 ${points.length}개를 불러왔어요.${skipped ? ` 숫자가 아닌 줄 ${skipped}개는 건너뛰었어요.` : ''}`, 'ok');
  });
  $('btnStdCsv').addEventListener('click', () => {
    const dv = derive();
    if (!dv.stdAll.length) return showMsg($('msg4'), '내려받을 표준곡선 점이 없어요.', 'warn');
    download('표준곡선.csv', toCSV([['농도(mg/L)', 'v/v0', '출처'], ...dv.stdAll.map((p) => [p.conc, +p.ratio.toFixed(5), p.source])]));
  });
  $('btnStdClear').addEventListener('click', async () => {
    if (!state.data.stdPoints.length) return;
    if (!(await askConfirm('직접 입력한 표준곡선 점을 모두 지울까요?', '모두 지우기', '취소', true))) return;
    state.data.stdPoints = [];
    savePersisted();
    renderData();
  });
  for (const id of ['sLo', 'sHi']) {
    $<HTMLSelectElement>(id).addEventListener('change', () => {
      const lo = Number($<HTMLSelectElement>('sLo').value);
      const hi = Number($<HTMLSelectElement>('sHi').value);
      if (!(hi > lo)) {
        showMsg($('msg4'), 'S 구간은 왼쪽 농도가 오른쪽보다 작아야 해요.', 'warn');
        return;
      }
      hideMsg($('msg4'));
      state.data.sRange = [lo, hi];
      savePersisted();
      renderData();
    });
  }

  // 표의 삭제 버튼
  $('stdTable').addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-std]');
    if (!b) return;
    state.data.stdPoints.splice(Number(b.dataset.std), 1);
    savePersisted();
    renderData();
  });
  $('recTable').addEventListener('click', async (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-rec]');
    if (!b) return;
    const r = state.data.records.find((x) => x.id === b.dataset.rec);
    if (!r || !(await askConfirm(`‘${r.name}’ 기록(v = ${fmt(r.v)} mm/s)을 지울까요?`, '지우기', '취소', true))) return;
    state.data.records = state.data.records.filter((x) => x.id !== r.id);
    savePersisted();
    renderData();
  });
  $('btnRecCsv').addEventListener('click', exportRecords);
  $('btnRecClear').addEventListener('click', async () => {
    if (!state.data.records.length) return;
    if (!(await askConfirm('측정 기록을 모두 지울까요? 되돌릴 수 없어요.', '모두 지우기', '취소', true))) return;
    state.data.records = [];
    savePersisted();
    renderData();
  });

  on('series', () => {
    segment = null;
  });
  on('track', () => {
    segment = null;
  });
}

// ───────────── ① 속도 ─────────────
function computeSegment() {
  series = positionSeries();
  autoFailed = false;
  if (series.t.length < 10) {
    segment = null;
    return;
  }
  if (state.manualSegment) {
    segment = segmentFromTimes(series.t, series.x, state.manualSegment[0], state.manualSegment[1]);
  } else {
    segment = detectConstantVelocity(series.t, series.x).segment;
    autoFailed = !segment;
  }
}

function renderVelocity(recompute: boolean) {
  if (recompute || !segment) computeSegment();
  const box = $('cvResult');
  box.className = 'callout';
  const has = series.t.length >= 10;
  $('chart4').parentElement!.hidden = !has;
  if (!has) {
    box.innerHTML = '아직 이번 영상의 추적 데이터가 없어요. 3단계에서 추적하거나, 아래 ‘측정 기록에 저장’에 속도를 직접 적어도 돼요.';
  } else if (!segment) {
    box.className = 'callout warn';
    box.innerHTML = state.manualSegment
      ? '고른 구간에 점이 너무 적어요. 구간을 더 넓게 골라 주세요.'
      : '<b>등속 구간을 찾지 못했어요.</b> 보트가 일정한 빠르기로 움직인 부분이 0.5초보다 짧거나, 추적이 흔들렸을 수 있어요. 아래 ‘구간 직접 고르기’에서 그래프가 곧게 뻗은 구간을 골라 주세요.';
    if (autoFailed) ($('manualBox') as HTMLDetailsElement).open = true;
  } else {
    const dur = segment.tEnd - segment.tStart;
    const how = state.manualSegment ? '직접 고른 구간' : '자동 탐지';
    box.innerHTML =
      `<b>v = ${fmt(segment.speed)} mm/s</b> · 등속 구간 ${fmt(segment.tStart)} ~ ${fmt(segment.tEnd)} s (${fmt(dur)}초, 점 ${segment.endIdx - segment.startIdx + 1}개) · R² = ${fmt(segment.fit.r2, 4)} · ${how}` +
      (dur < 1.5 ? '<br>구간이 짧아요(1.5초 미만). 추적 점이 흔들리면 짧아질 수 있으니 그래프를 보고 필요하면 직접 골라 주세요.' : '');
    if (dur < 1.5 || segment.fit.r2 < 0.98) box.className = 'callout warn';
    $<HTMLInputElement>('recV').value = segment.speed.toFixed(2);
    $<HTMLInputElement>('segStart').value = segment.tStart.toFixed(2);
    $<HTMLInputElement>('segEnd').value = segment.tEnd.toFixed(2);
  }
  if (!$<HTMLInputElement>('recName').value && state.source)
    $<HTMLInputElement>('recName').value = state.isDemo ? '하천수 A' : state.source.name.replace(/\.[^.]+$/, '');
  drawVelocityChart();
}

function drawVelocityChart() {
  const canvas = $<HTMLCanvasElement>('chart4');
  const inSeg: { x: number; y: number }[] = [];
  const outSeg: { x: number; y: number }[] = [];
  series.t.forEach((t, i) => {
    const p = { x: t, y: series.x[i] };
    if (segment && i >= segment.startIdx && i <= segment.endIdx) inSeg.push(p);
    else outSeg.push(p);
  });
  const line = segment
    ? [segment.tStart, segment.tEnd].map((t) => ({ x: t, y: segment!.fit.slope * t + segment!.fit.intercept }))
    : [];
  const pickPts = picks.map((t) => ({ x: t, y: interp(t) }));
  if (!chart4) {
    chart4 = makeChart(canvas, {
      type: 'scatter',
      data: {
        datasets: [
          { label: '등속 구간 밖', data: [], backgroundColor: C.blueFaint, borderColor: C.blueFaint, pointRadius: 2.5 },
          { label: '등속 구간', data: [], backgroundColor: C.orange, borderColor: C.orange, pointRadius: 2.5 },
          { type: 'line', label: '맞춘 직선 (기울기 = v)', data: [], borderColor: C.teal, borderWidth: 2, pointRadius: 0 },
          { label: '고른 점', data: [], backgroundColor: '#1a1d24', pointStyle: 'crossRot', pointRadius: 9, borderColor: '#1a1d24', borderWidth: 2 },
        ],
      },
      options: {
        scales: { x: axis('시간 (s)'), y: axis('위치 (mm)') },
        plugins: {
          legend: { position: 'top', align: 'end', labels: { usePointStyle: true, boxWidth: 8 } },
          tooltip: { callbacks: { label: (c) => `${(c.raw as { x: number }).x.toFixed(3)} s, ${(c.raw as { y: number }).y.toFixed(2)} mm` } },
        },
        onClick: (e) => {
          if (!($('manualBox') as HTMLDetailsElement).open || !chart4 || e.x === null || e.x === undefined) return;
          const t = chart4.scales.x.getValueForPixel(e.x);
          if (t === undefined || !isFinite(t)) return;
          picks.push(t);
          if (picks.length === 2) {
            state.manualSegment = [Math.min(...picks), Math.max(...picks)];
            picks = [];
            renderVelocity(true);
          } else {
            $<HTMLInputElement>('segStart').value = t.toFixed(2);
            $<HTMLInputElement>('segEnd').value = '';
            drawVelocityChart();
          }
        },
      },
    });
  }
  chart4.data.datasets[0].data = outSeg;
  chart4.data.datasets[1].data = inSeg;
  chart4.data.datasets[2].data = line;
  chart4.data.datasets[3].data = pickPts;
  chart4.update('none');
}

function interp(t: number): number {
  const { t: ts, x } = series;
  if (!ts.length) return 0;
  let i = ts.findIndex((v) => v >= t);
  if (i <= 0) return x[Math.max(0, i)];
  const f = (t - ts[i - 1]) / (ts[i] - ts[i - 1]);
  return x[i - 1] + f * (x[i] - x[i - 1]);
}

function saveRecord() {
  const msg = $('msg4');
  const name = $<HTMLInputElement>('recName').value.trim();
  const kind = $<HTMLSelectElement>('recKind').value as RecordKind;
  const v = parseNum($<HTMLInputElement>('recV'));
  const conc = parseNum($<HTMLInputElement>('recConc'));
  if (!name) return showMsg(msg, '시료 이름을 적어 주세요. 같은 시료를 여러 번 재면 이름을 똑같이 적으면 평균이 계산돼요.', 'warn');
  if (!(v > 0)) return showMsg(msg, '속도 v가 없어요. 등속 구간을 구하거나 속도를 숫자로 직접 적어 주세요.', 'warn');
  if (kind === 'standard' && !(conc >= 0)) return showMsg(msg, '표준용액은 농도(mg/L)를 숫자로 적어 주세요.', 'warn');
  const rec: RecordItem = {
    id: newId(),
    name,
    kind,
    v: +v.toFixed(4),
    createdAt: Date.now(),
    ...(kind === 'standard' ? { conc } : {}),
    ...(segment && Math.abs(segment.speed - v) < 0.005 ? { note: `${segment.tStart.toFixed(2)}~${segment.tEnd.toFixed(2)} s` } : {}),
  };
  state.data.records.push(rec);
  savePersisted();
  hideMsg(msg);
  renderData();
  toast(`‘${name}’ 기록을 저장했어요 (v = ${fmt(v)} mm/s).`);
}

// ───────────── ②③④ 기록·표준곡선 ─────────────
function renderData() {
  const dv = derive();
  renderV0(dv);
  renderCurve(dv);
  renderLod(dv);
  renderRecords(dv);
}

function renderV0(dv: Derived) {
  const blanks = state.data.records.filter((r) => r.kind === 'blank');
  const box = $('v0Box');
  if (!dv.v0) {
    box.innerHTML = `<div class="callout warn">정제수 기록이 ${blanks.length}개 있어요. <b>최소 3개</b>가 필요해요. 같은 세트의 정제수(0 mg/L) 영상을 3번 이상 분석해 종류를 ‘정제수’로 저장하세요.</div>`;
    return;
  }
  const vs = blanks.map((r) => r.v);
  box.innerHTML = `
    <div class="result-grid">
      <div class="stat"><span class="k">v<sub>0</sub> (정제수 v의 중앙값)</span><span class="v">${fmt(dv.v0)} mm/s</span></div>
      <div class="stat"><span class="k">정제수 측정 수</span><span class="v">${vs.length}개</span></div>
      <div class="stat"><span class="k">정제수 v의 RSD</span><span class="v">${fmt(rsdPercent(vs), 1)} %</span></div>
      <div class="stat"><span class="k">σ<sub>0</sub> (v/v<sub>0</sub> 표준편차)</span><span class="v">${fmt(dv.sigma0, 4)}</span></div>
    </div>
    <p class="muted small">정제수 v: ${vs.map((v) => fmt(v)).join(', ')} mm/s</p>`;
}

function curveEquation(f: CurveFit): string {
  const sign = f.b < 0 ? '−' : '+';
  const x = f.model === 'log' ? 'log<sub>10</sub>c' : 'c';
  return `v/v<sub>0</sub> = ${f.a.toFixed(4)} ${sign} ${Math.abs(f.b).toFixed(4)}·${x}`;
}

function renderCurve(dv: Derived) {
  const info = $('curveInfo');
  info.className = 'callout';
  const model = state.data.curveModel;
  $<HTMLSelectElement>('curveModel').value = model;
  if (!dv.fit) {
    info.className = 'callout warn';
    info.innerHTML =
      model === 'log'
        ? '표준곡선을 그리려면 농도가 0보다 큰 서로 다른 점이 2개 이상 필요해요. (로그 농도에서는 0 mg/L 점을 쓸 수 없어요)'
        : '표준곡선을 그리려면 서로 다른 농도의 점이 2개 이상 필요해요.';
  } else {
    const f = dv.fit;
    info.innerHTML = `${curveEquation(f)} · R² = ${f.r2.toFixed(4)} · 점 ${f.n}개 · 범위 ${fmtConc(f.cMin)} ~ ${fmtConc(f.cMax)} mg/L` +
      (model === 'log' && dv.stdAll.some((p) => p.conc === 0) ? '<br><span class="small">로그 농도에서는 0 mg/L 점이 곡선 맞춤과 그래프에서 빠져요.</span>' : '');
  }

  // 표준곡선 점 표
  const rows = dv.stdAll
    .map(
      (p) =>
        `<tr><td>${fmtConc(p.conc)}</td><td>${fmt(p.ratio, 4)}</td><td style="text-align:left">${esc(p.source)}</td><td>${
          p.manualIndex !== undefined ? `<button class="btn btn-small del" data-std="${p.manualIndex}">삭제</button>` : ''
        }</td></tr>`,
    )
    .join('');
  $('stdTable').innerHTML = `<thead><tr><th>농도 (mg/L)</th><th>v/v<sub>0</sub></th><th style="text-align:left">출처</th><th></th></tr></thead><tbody>${
    rows || '<tr><td colspan="4" class="empty">아직 점이 없어요. 위에서 추가하거나 CSV를 올리세요.</td></tr>'
  }</tbody>`;

  // 그래프
  const isLog = model === 'log';
  const shown = dv.stdAll.filter((p) => !isLog || p.conc > 0);
  const curve: { x: number; y: number }[] = [];
  if (dv.fit) {
    const f = dv.fit;
    const lo = isLog ? f.cMin : Math.max(0, f.cMin);
    for (let i = 0; i <= 60; i++) {
      const c = isLog ? lo * Math.pow(f.cMax / lo, i / 60) : lo + ((f.cMax - lo) * i) / 60;
      curve.push({ x: c, y: predictRatio(f, c) });
    }
  }
  const samples = sampleGroups(dv)
    .filter((g) => g.kind === 'sample' && g.conc !== null && g.inRange && isFinite(g.ratio))
    .map((g) => ({ x: g.conc!, y: g.ratio, name: g.name }));
  if (chart5) chart5.destroy();
  chart5 = makeChart($<HTMLCanvasElement>('chart5'), {
    type: 'scatter',
    data: {
      datasets: [
        { label: '표준용액', data: shown.map((p) => ({ x: p.conc, y: p.ratio })), backgroundColor: C.blue, borderColor: C.blue, pointRadius: 4 },
        { type: 'line', label: '표준곡선', data: curve, borderColor: C.teal, borderWidth: 2, pointRadius: 0 },
        { label: '시료 (추정 농도)', data: samples, backgroundColor: C.orange, borderColor: '#fff', borderWidth: 1.5, pointStyle: 'triangle', pointRadius: 8 },
      ],
    },
    options: {
      scales: {
        x: axis(isLog ? '농도 c (mg/L, 로그 눈금)' : '농도 c (mg/L)', isLog ? { type: 'logarithmic' } : {}),
        y: axis('상대속도 v/v₀'),
      },
      plugins: {
        legend: { position: 'top', align: 'end', labels: { usePointStyle: true, boxWidth: 8 } },
        tooltip: {
          callbacks: {
            label: (c) => {
              const p = c.raw as { x: number; y: number; name?: string };
              return `${p.name ?? c.dataset.label}: ${fmtConc(p.x)} mg/L, v/v₀ = ${p.y.toFixed(3)}`;
            },
          },
        },
      },
    },
  });
}

function renderLod(dv: Derived) {
  const concs = [...new Set(dv.stdAll.map((p) => p.conc))].sort((a, b) => a - b);
  const opts = (sel: number | undefined) => concs.map((c) => `<option value="${c}"${c === sel ? ' selected' : ''}>${fmtConc(c)}</option>`).join('');
  $('sLo').innerHTML = opts(dv.sRange?.[0]);
  $('sHi').innerHTML = opts(dv.sRange?.[1]);
  const box = $('lodBox');
  const missing: string[] = [];
  if (dv.sigma0 === null) missing.push('σ₀를 구하려면 정제수 기록이 3개 이상 필요해요');
  if (!dv.S) missing.push('S를 구하려면 고른 구간 안에 서로 다른 농도의 점이 2개 이상 필요해요');
  box.innerHTML = `
    <div class="stat"><span class="k">σ<sub>0</sub>${dv.sigmaSource ? ` (${esc(dv.sigmaSource)})` : ''}</span><span class="v">${fmt(dv.sigma0, 4)}</span></div>
    <div class="stat"><span class="k">S (1 mg/L당 v/v<sub>0</sub> 변화)</span><span class="v">${dv.S ? dv.S.slope.toFixed(4) : '—'}</span></div>
    <div class="stat"><span class="k">S 직선의 R²</span><span class="v">${dv.S ? dv.S.r2.toFixed(4) : '—'}</span></div>
    <div class="stat"><span class="k">감지한계 LOD</span><span class="v">${dv.lod !== null ? `${fmtConc(dv.lod)} mg/L` : '—'}</span></div>
    <div class="stat"><span class="k">정량한계 LOQ</span><span class="v">${dv.loq !== null ? `${fmtConc(dv.loq)} mg/L` : '—'}</span></div>
    ${missing.length ? `<div class="callout warn" style="grid-column:1/-1">${missing.join('. ')}.</div>` : ''}`;
}

interface Group {
  key: string;
  name: string;
  kind: RecordKind;
  stdConc?: number;
  vs: number[];
  ratio: number;
  ratios: number[];
  conc: number | null;
  inRange: boolean;
  notes: string[];
}

function sampleGroups(dv: Derived): Group[] {
  const map = new Map<string, RecordItem[]>();
  for (const r of state.data.records) {
    const key = `${r.kind}|${r.name}|${r.conc ?? ''}`;
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(r);
  }
  return [...map.entries()].map(([key, rs]) => {
    const vs = rs.map((r) => r.v);
    const ratios = dv.v0 ? vs.map((v) => v / dv.v0!) : [];
    const ratio = ratios.length ? mean(ratios) : NaN;
    const kind = rs[0].kind;
    let conc: number | null = null;
    let notes: string[] = [];
    let inRange = false;
    if (kind !== 'blank' && dv.v0) {
      const e = estimate(dv, ratio);
      conc = e.conc;
      notes = e.notes;
      inRange = conc !== null && !notes.some((n) => n.startsWith('범위 밖'));
    }
    return { key, name: rs[0].name, kind, stdConc: rs[0].conc, vs, ratio, ratios, conc, inRange, notes };
  });
}

function renderRecords(dv: Derived) {
  const recs = state.data.records;
  const rows = recs
    .map((r) => {
      const ratio = dv.v0 ? r.v / dv.v0 : NaN;
      let conc = '—';
      let note = '';
      if (r.kind === 'blank') note = '기준';
      else if (!dv.v0) note = 'v₀ 필요 (정제수 3개)';
      else {
        const e = estimate(dv, ratio);
        conc = fmtConc(e.conc);
        note = e.notes.join(', ');
      }
      return `<tr><td>${esc(r.name)}</td><td>${KIND_LABEL[r.kind]}</td><td>${r.kind === 'standard' ? fmtConc(r.conc) : ''}</td><td>${fmt(r.v)}</td><td>${fmt(ratio, 4)}</td><td>${conc}</td><td class="note">${esc(note)}</td><td><button class="btn btn-small del" data-rec="${r.id}">삭제</button></td></tr>`;
    })
    .join('');
  $('recTable').innerHTML = `<thead><tr><th>시료 이름</th><th>종류</th><th>표준 농도 (mg/L)</th><th>v (mm/s)</th><th>v/v<sub>0</sub></th><th>추정 농도 (mg/L)</th><th style="text-align:left">비고</th><th></th></tr></thead><tbody>${
    rows || '<tr><td colspan="8" class="empty">아직 기록이 없어요. ①에서 ‘기록에 저장’을 누르세요.</td></tr>'
  }</tbody>`;

  const groups = sampleGroups(dv);
  const sumRows = groups
    .map((g) => {
      const conc = g.kind === 'blank' ? '0 (기준)' : fmtConc(g.conc);
      return `<tr><td>${esc(g.name)}</td><td>${KIND_LABEL[g.kind]}</td><td>${g.vs.length}</td><td>${fmt(mean(g.vs))}</td><td>${fmt(rsdPercent(g.vs), 1)}</td><td>${fmt(g.ratio, 4)}</td><td>${fmt(rsdPercent(g.ratios), 1)}</td><td>${conc}</td><td class="note">${esc(g.notes.join(', '))}</td></tr>`;
    })
    .join('');
  $('sumTable').innerHTML = `<thead><tr><th>시료 이름</th><th>종류</th><th>측정 수</th><th>평균 v (mm/s)</th><th>v RSD (%)</th><th>평균 v/v<sub>0</sub></th><th>v/v<sub>0</sub> RSD (%)</th><th>추정 농도 (mg/L)</th><th style="text-align:left">비고</th></tr></thead><tbody>${
    sumRows || '<tr><td colspan="9" class="empty">기록이 생기면 같은 이름끼리 묶어서 평균과 RSD를 보여 줘요.</td></tr>'
  }</tbody>`;
}

function exportRecords() {
  if (!state.data.records.length) return showMsg($('msg4'), '내보낼 측정 기록이 없어요.', 'warn');
  const dv = derive();
  const rows: (string | number | null)[][] = [['[측정 기록]'], ['시료 이름', '종류', '표준 농도(mg/L)', 'v(mm/s)', 'v/v0', '추정 농도(mg/L)', '비고', '등속 구간', '저장 시각']];
  for (const r of state.data.records) {
    const ratio = dv.v0 ? r.v / dv.v0 : NaN;
    const e = r.kind !== 'blank' && dv.v0 ? estimate(dv, ratio) : { conc: null, notes: r.kind === 'blank' ? ['기준'] : [] };
    rows.push([r.name, KIND_LABEL[r.kind], r.conc ?? '', r.v, isFinite(ratio) ? +ratio.toFixed(5) : '', e.conc !== null ? +e.conc.toFixed(4) : '', e.notes.join('; '), r.note ?? '', new Date(r.createdAt).toLocaleString('ko-KR')]);
  }
  rows.push([], ['[시료별 요약]'], ['시료 이름', '종류', '측정 수', '평균 v(mm/s)', 'v RSD(%)', '평균 v/v0', 'v/v0 RSD(%)', '추정 농도(mg/L)', '비고']);
  for (const g of sampleGroups(dv)) {
    rows.push([g.name, KIND_LABEL[g.kind], g.vs.length, +mean(g.vs).toFixed(4), isFinite(rsdPercent(g.vs)) ? +rsdPercent(g.vs).toFixed(2) : '', isFinite(g.ratio) ? +g.ratio.toFixed(5) : '', isFinite(rsdPercent(g.ratios)) ? +rsdPercent(g.ratios).toFixed(2) : '', g.conc !== null ? +g.conc.toFixed(4) : '', g.notes.join('; ')]);
  }
  rows.push([], ['[계산 조건]']);
  rows.push(['v0(mm/s)', dv.v0 ?? '', 'σ0', dv.sigma0 ?? '', 'σ0 출처', dv.sigmaSource]);
  if (dv.fit) rows.push(['표준곡선', dv.fit.model === 'log' ? 'v/v0 = a + b·log10(c)' : 'v/v0 = a + b·c', 'a', +dv.fit.a.toFixed(6), 'b', +dv.fit.b.toFixed(6), 'R²', +dv.fit.r2.toFixed(5)]);
  if (dv.S && dv.sRange) rows.push(['S 구간(mg/L)', `${dv.sRange[0]}~${dv.sRange[1]}`, 'S', +dv.S.slope.toFixed(6), 'LOD(mg/L)', dv.lod ?? '', 'LOQ(mg/L)', dv.loq ?? '']);
  download('측정기록.csv', toCSV(rows));
}

export function renderStep4() {
  renderVelocity(true);
  renderData();
}
