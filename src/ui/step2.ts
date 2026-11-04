import type { Point } from '../lib/tracking';
import { emit, frameCount, on, pxPerMm, state, type Rect } from '../state';
import { $, hideMsg, parseNum, showMsg } from './dom';
import { goFrame, stepFrame } from './step1';
import { Viewer } from './viewer';

type Mode = 'ruler' | 'roi' | null;

let viewer: Viewer;
let mode: Mode = null;
let drag: { kind: 'a' | 'b' | 'roi'; start: Point } | null = null;
let hover: Point | null = null;
let roiDraft: Rect | null = null;

export function initStep2() {
  const canvas = $<HTMLCanvasElement>('view2');
  viewer = new Viewer(canvas, () => state.source);
  viewer.overlay = drawOverlay;

  $('modeRuler').addEventListener('click', () => setMode(mode === 'ruler' ? null : 'ruler'));
  $('modeRoi').addEventListener('click', () => setMode(mode === 'roi' ? null : 'roi'));
  $('prev2').addEventListener('click', () => stepFrame(-1));
  $('next2').addEventListener('click', () => stepFrame(1));
  $<HTMLInputElement>('seek2').addEventListener('input', (e) => goFrame(Number((e.target as HTMLInputElement).value)));

  const mm = $<HTMLInputElement>('mmInput');
  mm.addEventListener('input', () => {
    const v = parseNum(mm);
    state.ruler.mm = v > 0 ? v : null;
    invalidate();
    updateStats();
  });

  canvas.addEventListener('pointerdown', (e) => {
    if (!state.source) return;
    const p = clampToFrame(viewer.toVideo(e.clientX, e.clientY));
    if (!mode) {
      // 모드를 안 골랐으면: 기존 점 근처면 그 점을 옮기고, 아니면 안내
      const near = nearPoint(p);
      if (near) {
        drag = { kind: near, start: p };
        canvas.setPointerCapture(e.pointerId);
        return;
      }
      showMsg($('msg2'), '먼저 위의 ‘눈금 두 점 찍기’ 또는 ‘수로 영역 그리기’ 버튼을 눌러 주세요.', 'warn');
      return;
    }
    hideMsg($('msg2'));
    canvas.setPointerCapture(e.pointerId);
    e.preventDefault();
    if (mode === 'ruler') {
      const near = nearPoint(p);
      let kind: 'a' | 'b';
      if (near) kind = near;
      else if (!state.ruler.a || state.ruler.b) {
        state.ruler.a = p;
        state.ruler.b = null;
        kind = 'a';
      } else {
        state.ruler.b = p;
        kind = 'b';
      }
      drag = { kind, start: p };
      hover = p;
    } else {
      drag = { kind: 'roi', start: p };
      roiDraft = { x: p.x, y: p.y, w: 0, h: 0 };
    }
    viewer.render();
  });

  canvas.addEventListener('pointermove', (e) => {
    if (!state.source) return;
    const p = clampToFrame(viewer.toVideo(e.clientX, e.clientY));
    hover = mode === 'ruler' || drag?.kind === 'a' || drag?.kind === 'b' ? p : null;
    if (drag?.kind === 'a') state.ruler.a = p;
    else if (drag?.kind === 'b') state.ruler.b = p;
    else if (drag?.kind === 'roi') roiDraft = normRect(drag.start, p);
    viewer.render();
    if (drag && drag.kind !== 'roi') updateStats();
  });

  const end = () => {
    if (!drag) return;
    if (drag.kind === 'roi' && roiDraft) {
      if (roiDraft.w >= 10 && roiDraft.h >= 10) {
        state.roi = roundRect(roiDraft);
        setMode(null);
      } else showMsg($('msg2'), '사각형이 너무 작아요. 물길 한쪽 모서리에서 반대쪽 모서리까지 끌어 주세요.', 'warn');
      roiDraft = null;
    }
    if (drag.kind === 'b' && state.ruler.a && state.ruler.b) {
      setMode(null);
      if (!state.ruler.mm) $<HTMLInputElement>('mmInput').focus({ preventScroll: true });
    }
    drag = null;
    hover = null;
    invalidate();
    updateStats();
    viewer.render();
  };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);
  canvas.addEventListener('pointerleave', () => {
    if (!drag) {
      hover = null;
      viewer.render();
    }
  });

  on('frame', () => {
    if (!$('step2').hidden) {
      viewer.render();
      syncSeek();
    }
  });
  on('source', () => {
    setMode(null);
    $<HTMLInputElement>('mmInput').value = state.ruler.mm ? String(state.ruler.mm) : '';
    updateStats();
  });
}

function setMode(m: Mode) {
  mode = m;
  $('modeRuler').setAttribute('aria-pressed', String(m === 'ruler'));
  $('modeRoi').setAttribute('aria-pressed', String(m === 'roi'));
  hover = null;
  viewer?.render();
}

function nearPoint(p: Point): 'a' | 'b' | null {
  const tol = 18 / (viewer.scale / (window.devicePixelRatio || 1)); // 화면에서 약 18px
  const { a, b } = state.ruler;
  if (b && Math.hypot(p.x - b.x, p.y - b.y) < tol) return 'b';
  if (a && Math.hypot(p.x - a.x, p.y - a.y) < tol) return 'a';
  return null;
}

function clampToFrame(p: Point): Point {
  const s = state.source!;
  return { x: Math.max(0, Math.min(s.width, p.x)), y: Math.max(0, Math.min(s.height, p.y)) };
}

function normRect(a: Point, b: Point): Rect {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) };
}

function roundRect(r: Rect): Rect {
  const x = Math.round(r.x);
  const y = Math.round(r.y);
  return { x, y, w: Math.round(r.x + r.w) - x, h: Math.round(r.y + r.h) - y };
}

/** 축척이나 영역이 바뀌면 이전 추적 결과는 버림 */
function invalidate() {
  if (state.track || state.samples.length) {
    state.track = null;
    state.samples = [];
    state.manualSegment = null;
    emit('track');
  }
}

function drawOverlay(ctx: CanvasRenderingContext2D, toC: (p: Point) => Point, k: number) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const W = ctx.canvas.width;
  const H = ctx.canvas.height;
  const roi = roiDraft ?? state.roi;
  if (roi) {
    const p = toC({ x: roi.x, y: roi.y });
    const w = roi.w * k;
    const h = roi.h * k;
    ctx.save();
    ctx.fillStyle = 'rgba(15,20,40,0.45)';
    ctx.beginPath();
    ctx.rect(0, 0, W, H);
    ctx.rect(p.x, p.y, w, h);
    ctx.fill('evenodd');
    ctx.strokeStyle = '#e0701e';
    ctx.lineWidth = 2.5 * dpr;
    ctx.setLineDash(roiDraft ? [8 * dpr, 6 * dpr] : []);
    ctx.strokeRect(p.x, p.y, w, h);
    ctx.fillStyle = '#e0701e';
    ctx.font = `600 ${13 * dpr}px sans-serif`;
    ctx.fillText('수로 영역', p.x + 6 * dpr, p.y - 6 * dpr > 12 * dpr ? p.y - 6 * dpr : p.y + 18 * dpr);
    ctx.restore();
  }
  const { a, b } = state.ruler;
  ctx.save();
  ctx.lineWidth = 2 * dpr;
  if (a && b) {
    const pa = toC(a);
    const pb = toC(b);
    ctx.strokeStyle = '#ffd400';
    ctx.beginPath();
    ctx.moveTo(pa.x, pa.y);
    ctx.lineTo(pb.x, pb.y);
    ctx.stroke();
  }
  for (const [p, label] of [[a, 'A'], [b, 'B']] as const) {
    if (!p) continue;
    const c = toC(p);
    const r = 9 * dpr;
    ctx.strokeStyle = '#ffd400';
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.beginPath();
    ctx.arc(c.x, c.y, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(c.x - r * 1.6, c.y);
    ctx.lineTo(c.x + r * 1.6, c.y);
    ctx.moveTo(c.x, c.y - r * 1.6);
    ctx.lineTo(c.x, c.y + r * 1.6);
    ctx.stroke();
    ctx.font = `700 ${13 * dpr}px sans-serif`;
    ctx.fillRect(c.x + r, c.y - r * 2.4, 16 * dpr, 17 * dpr);
    ctx.fillStyle = '#ffd400';
    ctx.fillText(label, c.x + r + 3 * dpr, c.y - r * 2.4 + 13 * dpr);
  }
  ctx.restore();
  if (hover) viewer.drawLoupe(hover);
}

function updateStats() {
  const { a, b } = state.ruler;
  const d = a && b ? Math.hypot(b.x - a.x, b.y - a.y) : null;
  $('pxDist').textContent = d ? `${d.toFixed(1)} px` : '—';
  const k = pxPerMm();
  $('pxPerMm').textContent = k ? `${k.toFixed(3)} px/mm` : '—';
  $('roiInfo').textContent = state.roi ? `${state.roi.w} × ${state.roi.h} px` : '—';
  const msg = $('msg2');
  if (d !== null && d < 80 && !drag) showMsg(msg, '두 점이 너무 가까워요. 자에서 되도록 멀리 떨어진 두 눈금을 고르면 오차가 줄어요.', 'warn');
}

function syncSeek() {
  const seek = $<HTMLInputElement>('seek2');
  seek.max = String(Math.max(0, frameCount() - 1));
  seek.value = String(state.frame);
}

export function renderStep2() {
  if (!state.source) return;
  $<HTMLInputElement>('mmInput').value = state.ruler.mm ? String(state.ruler.mm) : '';
  syncSeek();
  updateStats();
  viewer.render();
}
