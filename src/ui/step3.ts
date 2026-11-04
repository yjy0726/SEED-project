import { toCSV } from '../lib/csv';
import { detectBlob, medianBackground, suggestThreshold, type Point } from '../lib/tracking';
import { positionSeries } from '../series';
import { emit, on, pxPerMm, samplePoint, state, type Rect, type Sample } from '../state';
import type { GrabMode } from '../source';
import { axis, C, makeChart, type Chart } from './charts';
import { $, download, hideMsg, showMsg, toast } from './dom';
import { Viewer } from './viewer';

let viewer: Viewer;
let chart: Chart | null = null;
let manualMode = false;
let busy = false;
let detectTimer = 0;

export function initStep3() {
  viewer = new Viewer($<HTMLCanvasElement>('view3'), () => state.source);
  viewer.overlay = drawOverlay;

  $('btnTrack').addEventListener('click', runTracking);
  const thr = $<HTMLInputElement>('thr');
  thr.addEventListener('input', () => {
    state.threshold = Number(thr.value);
    $('thrVal').textContent = thr.value;
    scheduleDetect();
  });
  const minArea = $<HTMLInputElement>('minArea');
  minArea.addEventListener('input', () => {
    state.minArea = Number(minArea.value);
    $('minAreaVal').textContent = minArea.value;
    scheduleDetect();
  });
  $('thrAuto').addEventListener('click', () => {
    const tr = state.track;
    if (!tr) return;
    setThreshold(suggestThreshold(tr.frames, tr.bg));
    detectAll();
    toast(`임계값을 ${state.threshold}(으)로 정했어요.`);
  });

  $('prev3').addEventListener('click', () => stepSample(-1));
  $('next3').addEventListener('click', () => stepSample(1));
  $<HTMLInputElement>('seek3').addEventListener('input', (e) => showSample(Number((e.target as HTMLInputElement).value)));

  $('btnManual').addEventListener('click', () => {
    manualMode = !manualMode;
    $('btnManual').setAttribute('aria-pressed', String(manualMode));
    $('view3').classList.toggle('drawable', manualMode);
  });
  $('view3').addEventListener('click', (e) => {
    const s = state.samples[state.sampleIdx];
    if (!s) return;
    if (!manualMode) {
      showMsg($('msg3'), '위치를 고치려면 먼저 ‘직접 찍기’ 버튼을 눌러 켜 주세요.', 'warn');
      return;
    }
    hideMsg($('msg3'));
    s.manual = viewer.toVideo(e.clientX, e.clientY);
    s.excluded = false;
    afterEdit();
    if ($<HTMLInputElement>('autoNext').checked && state.sampleIdx < state.samples.length - 1) stepSample(1);
  });
  $('btnUndoManual').addEventListener('click', () => {
    const s = state.samples[state.sampleIdx];
    if (!s) return;
    s.manual = null;
    s.excluded = false;
    afterEdit();
  });
  $('btnExclude').addEventListener('click', () => {
    const s = state.samples[state.sampleIdx];
    if (!s) return;
    s.excluded = !s.excluded;
    afterEdit();
  });
  $('btnCsv3').addEventListener('click', exportCsv);

  on('track', () => {
    if (!state.track) {
      $('trackPanel').hidden = true;
      $('trackSummary').textContent = '';
    }
  });
}

function setThreshold(v: number) {
  state.threshold = Math.round(v);
  const thr = $<HTMLInputElement>('thr');
  thr.value = String(state.threshold);
  $('thrVal').textContent = String(state.threshold);
}

/** 수로 영역을 조금 넓힌 화면 영역 */
function viewCrop(roi: Rect): Rect {
  const s = state.source!;
  const mx = roi.w * 0.06;
  const my = Math.max(roi.h * 0.25, 10);
  let x = Math.max(0, roi.x - mx);
  let y = Math.max(0, roi.y - my);
  let w = Math.min(s.width, roi.x + roi.w + mx) - x;
  let h = Math.min(s.height, roi.y + roi.h + my) - y;
  // 너무 납작하면(가로:세로 > 4) 클릭하기 어려우므로 위아래를 넓힘
  if (w / h > 4) {
    const want = Math.min(s.height, w / 4);
    const cy = y + h / 2;
    y = Math.max(0, Math.min(s.height - want, cy - want / 2));
    h = want;
  }
  return { x, y, w, h };
}

async function runTracking() {
  if (busy) return;
  const src = state.source;
  const msg = $('msg3');
  hideMsg(msg);
  if (!src) return showMsg(msg, '영상이 없어요. 1단계에서 영상을 먼저 불러와 주세요.');
  if (!pxPerMm()) return showMsg(msg, '축척이 없어요. 2단계에서 두 점과 실제 길이를 정해 주세요.');
  const roi = state.roi;
  if (!roi) return showMsg(msg, '수로 영역이 없어요. 2단계에서 수로를 사각형으로 감싸 주세요.');

  busy = true;
  const btn = $<HTMLButtonElement>('btnTrack');
  btn.disabled = true;
  const prog = $('progress3');
  const bar = prog.querySelector<HTMLElement>('.bar')!;
  const ptext = prog.querySelector<HTMLElement>('.ptext')!;
  prog.hidden = false;
  bar.style.width = '0%';
  ptext.textContent = '프레임 읽는 중…';
  const t0 = performance.now();
  try {
    const k = Math.min(1, 640 / roi.w, 400 / roi.h);
    const w = Math.max(8, Math.round(roi.w * k));
    const h = Math.max(8, Math.round(roi.h * k));
    const mode = $<HTMLSelectElement>('grabMode').value as GrabMode;
    const { times, frames } = await src.grab(roi, w, h, mode, state.fps, (p) => {
      bar.style.width = `${(p * 90).toFixed(1)}%`;
      ptext.textContent = `프레임 읽는 중… ${Math.round(p * 100)}%`;
    });
    if (frames.length < 5) throw new Error('frames');
    ptext.textContent = '보트 찾는 중…';
    await new Promise((r) => setTimeout(r, 0));
    const bg = medianBackground(frames);
    state.track = { times, frames, w, h, roi: { ...roi }, bg };
    state.samples = times.map((t) => ({ t, auto: null, autoArea: 0, manual: null, excluded: false }));
    state.manualSegment = null;
    setThreshold(suggestThreshold(frames, bg));
    detectAll(false);
    const sec = (performance.now() - t0) / 1000;
    bar.style.width = '100%';
    const how = src.lastMethod ? ` · ${src.lastMethod}` : '';
    ptext.textContent = `분석 완료 · ${sec.toFixed(1)}초 · 프레임 ${frames.length}장${how}`;
    $('trackPanel').hidden = false;
    viewer.crop = viewCrop(roi);
    // 보트가 처음 잡힌 프레임부터 보여 줌
    const first = state.samples.findIndex((s) => s.auto);
    showSample(Math.max(0, first));
    const found = state.samples.filter((s) => s.auto).length;
    if (found < state.samples.length * 0.5)
      showMsg(msg, '보트를 찾지 못한 프레임이 많아요. 임계값을 낮추거나, 수로 영역을 보트가 지나가는 곳에 맞게 다시 그려 보세요.', 'warn');
  } catch {
    prog.hidden = true;
    showMsg(msg, '영상을 읽는 중에 문제가 생겼어요. ‘분석 방식’을 ‘호환 모드’로 바꿔 다시 눌러 보세요.');
  } finally {
    busy = false;
    btn.disabled = false;
  }
}

function scheduleDetect() {
  clearTimeout(detectTimer);
  detectTimer = window.setTimeout(() => detectAll(), 60);
}

/** 저장해 둔 프레임 전체에 대해 보트 위치를 다시 찾는다 (직접 찍은 점은 유지) */
function detectAll(rerender = true) {
  const tr = state.track;
  if (!tr) return;
  const sx = tr.roi.w / tr.w;
  const sy = tr.roi.h / tr.h;
  tr.frames.forEach((g, i) => {
    const b = detectBlob(g, tr.bg, tr.w, tr.h, state.threshold, state.minArea);
    const s = state.samples[i];
    s.auto = b ? { x: tr.roi.x + b.cx * sx, y: tr.roi.y + b.cy * sy } : null;
    s.autoArea = b?.area ?? 0;
  });
  state.manualSegment = null;
  emit('series');
  if (rerender) {
    showSample(state.sampleIdx);
  }
}

function afterEdit() {
  emit('series');
  showSample(state.sampleIdx);
}

export function stepSample(d: number) {
  if (!state.samples.length) return;
  showSample(state.sampleIdx + d);
}

function showSample(i: number) {
  const n = state.samples.length;
  if (!n || !state.source) return;
  state.sampleIdx = Math.max(0, Math.min(n - 1, i));
  const s = state.samples[state.sampleIdx];
  const seek = $<HTMLInputElement>('seek3');
  seek.max = String(n - 1);
  seek.value = String(state.sampleIdx);
  const status = s.excluded ? '제외함' : s.manual ? '직접 찍음' : s.auto ? `자동 (크기 ${s.autoArea}화소)` : '보트 못 찾음';
  $('sampleInfo').textContent = `분석 프레임 ${state.sampleIdx + 1} / ${n} · 시간 ${s.t.toFixed(3)} s · ${status}`;
  $('btnExclude').textContent = s.excluded ? '이 프레임 다시 포함' : '이 프레임 제외';
  drawMask();
  updateSummary();
  updateChart();
  state.source.seekTime(s.t + 0.5 / state.fps).then(() => {
    if (state.samples[state.sampleIdx] === s) viewer.render();
  });
}

function drawOverlay(ctx: CanvasRenderingContext2D, toC: (p: Point) => Point) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const tr = state.track;
  if (tr) {
    const a = toC({ x: tr.roi.x, y: tr.roi.y });
    const b = toC({ x: tr.roi.x + tr.roi.w, y: tr.roi.y + tr.roi.h });
    ctx.strokeStyle = 'rgba(224,112,30,0.8)';
    ctx.lineWidth = 1.5 * dpr;
    ctx.setLineDash([6 * dpr, 5 * dpr]);
    ctx.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y);
    ctx.setLineDash([]);
  }
  // 지나온 자취
  ctx.fillStyle = 'rgba(255,212,0,0.85)';
  for (let i = 0; i < state.sampleIdx; i++) {
    const p = samplePoint(state.samples[i]);
    if (!p) continue;
    const c = toC(p);
    ctx.fillRect(c.x - 1.2 * dpr, c.y - 1.2 * dpr, 2.4 * dpr, 2.4 * dpr);
  }
  const s: Sample | undefined = state.samples[state.sampleIdx];
  if (!s) return;
  const r = 10 * dpr;
  if (s.auto) {
    const c = toC(s.auto);
    ctx.lineWidth = 2.5 * dpr;
    ctx.strokeStyle = s.manual || s.excluded ? 'rgba(255,255,255,0.6)' : '#ffffff';
    ctx.beginPath();
    ctx.arc(c.x, c.y, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.strokeStyle = C.blue;
    ctx.lineWidth = 1.2 * dpr;
    ctx.stroke();
  }
  if (s.manual) {
    const c = toC(s.manual);
    ctx.beginPath();
    ctx.moveTo(c.x, c.y - r);
    ctx.lineTo(c.x + r * 0.95, c.y + r * 0.7);
    ctx.lineTo(c.x - r * 0.95, c.y + r * 0.7);
    ctx.closePath();
    ctx.lineWidth = 2.5 * dpr;
    ctx.strokeStyle = C.orange;
    ctx.stroke();
  }
  if (s.excluded) {
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(0, 0, ctx.canvas.width, 30 * dpr);
    ctx.fillStyle = '#fff';
    ctx.font = `600 ${14 * dpr}px sans-serif`;
    ctx.fillText('이 프레임은 분석에서 제외했어요', 10 * dpr, 20 * dpr);
  }
}

function drawMask() {
  const tr = state.track;
  if (!tr) return;
  const canvas = $<HTMLCanvasElement>('mask3');
  canvas.width = tr.w;
  canvas.height = tr.h;
  canvas.style.imageRendering = 'pixelated';
  const ctx = canvas.getContext('2d')!;
  const gray = tr.frames[state.sampleIdx];
  const mask = new Uint8Array(tr.w * tr.h);
  detectBlob(gray, tr.bg, tr.w, tr.h, state.threshold, state.minArea, mask);
  const img = ctx.createImageData(tr.w, tr.h);
  const d = img.data;
  for (let i = 0, j = 0; i < mask.length; i++, j += 4) {
    if (mask[i] === 2) {
      d[j] = 224; d[j + 1] = 112; d[j + 2] = 30;
    } else if (mask[i] === 1) {
      d[j] = 127; d[j + 1] = 178; d[j + 2] = 255;
    } else {
      const v = 20 + gray[i] * 0.35;
      d[j] = v; d[j + 1] = v; d[j + 2] = v;
    }
    d[j + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
}

function updateSummary() {
  const n = state.samples.length;
  const auto = state.samples.filter((s) => s.auto && !s.manual && !s.excluded).length;
  const man = state.samples.filter((s) => s.manual && !s.excluded).length;
  const exc = state.samples.filter((s) => s.excluded).length;
  const miss = state.samples.filter((s) => !s.auto && !s.manual && !s.excluded).length;
  $('trackSummary').textContent = `전체 ${n}프레임 · 자동 추적 ${auto} · 직접 찍음 ${man} · 제외 ${exc} · 못 찾음 ${miss}`;
}

function updateChart() {
  const ser = positionSeries();
  const autoPts: { x: number; y: number; i: number }[] = [];
  const manPts: { x: number; y: number; i: number }[] = [];
  ser.t.forEach((t, k) => (ser.manual[k] ? manPts : autoPts).push({ x: t, y: ser.x[k], i: ser.idx[k] }));
  const cur = state.samples[state.sampleIdx];
  const curIdx = ser.idx.indexOf(state.sampleIdx);
  const curPts = cur && curIdx >= 0 ? [{ x: ser.t[curIdx], y: ser.x[curIdx], i: state.sampleIdx }] : [];
  const canvas = $<HTMLCanvasElement>('chart3');
  if (!chart || chart.canvas !== canvas) {
    chart = makeChart(canvas, {
      type: 'scatter',
      data: {
        datasets: [
          { label: '자동 추적', data: [], backgroundColor: C.blue, borderColor: C.blue, pointRadius: 2.5, pointHoverRadius: 6 },
          { label: '직접 찍은 점', data: [], backgroundColor: C.orange, borderColor: C.orange, pointStyle: 'triangle', pointRadius: 5, pointHoverRadius: 8 },
          { label: '지금 보는 프레임', data: [], backgroundColor: 'rgba(0,0,0,0)', borderColor: '#1a1d24', borderWidth: 2, pointRadius: 8, pointHoverRadius: 8 },
        ],
      },
      options: {
        scales: { x: axis('시간 (s)'), y: axis('위치 (mm)') },
        plugins: {
          legend: { position: 'top', align: 'end', labels: { usePointStyle: true, boxWidth: 8 } },
          tooltip: {
            callbacks: {
              label: (c) => {
                const p = c.raw as { x: number; y: number };
                return `${c.dataset.label}: ${p.x.toFixed(3)} s, ${p.y.toFixed(2)} mm`;
              },
            },
          },
        },
        onClick: (_e, els) => {
          const el = els[0];
          if (!el) return;
          const raw = chart!.data.datasets[el.datasetIndex].data[el.index] as unknown as { i: number };
          showSample(raw.i);
        },
      },
    });
  }
  chart.data.datasets[0].data = autoPts;
  chart.data.datasets[1].data = manPts;
  chart.data.datasets[2].data = curPts;
  chart.update('none');
}

function exportCsv() {
  if (!state.samples.length) {
    showMsg($('msg3'), '내려받을 데이터가 없어요. 먼저 ‘자동 추적 시작’을 눌러 주세요.', 'warn');
    return;
  }
  const ser = positionSeries();
  const posByIdx = new Map(ser.idx.map((i, k) => [i, ser.x[k]]));
  const rows: (string | number)[][] = [['프레임', '시간(s)', '위치(mm)', 'x(px)', 'y(px)', '상태']];
  state.samples.forEach((s, i) => {
    const p = samplePoint(s);
    const status = s.excluded ? '제외' : s.manual ? '직접' : s.auto ? '자동' : '못 찾음';
    rows.push([
      i + 1,
      +s.t.toFixed(4),
      posByIdx.has(i) ? +posByIdx.get(i)!.toFixed(3) : '',
      p ? +p.x.toFixed(2) : '',
      p ? +p.y.toFixed(2) : '',
      status,
    ]);
  });
  const base = (state.source?.name ?? '영상').replace(/\.[^.]+$/, '');
  download(`${base}_시간-위치.csv`, toCSV(rows));
}

export function renderStep3() {
  hideMsg($('msg3'));
  if (state.track && state.samples.length) {
    $('trackPanel').hidden = false;
    if (state.roi) viewer.crop = viewCrop(state.track.roi);
    showSample(state.sampleIdx);
  } else {
    $('trackPanel').hidden = true;
    $('progress3').hidden = true;
  }
}
