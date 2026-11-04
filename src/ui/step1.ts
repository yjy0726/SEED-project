import { readFpsFromFile } from '../lib/mp4fps';
import { emit, frameCount, state } from '../state';
import { VideoSource, type FrameSource } from '../source';
import { $, hideMsg, parseNum, showMsg } from './dom';
import { Viewer } from './viewer';

let viewer: Viewer;

export function initStep1() {
  viewer = new Viewer($<HTMLCanvasElement>('view1'), () => state.source);
  const file = $<HTMLInputElement>('fileInput');
  const msg = $('msg1');
  const fpsInput = $<HTMLInputElement>('fpsInput');

  file.addEventListener('change', async () => {
    const f = file.files?.[0];
    file.value = '';
    if (!f) return;
    hideMsg(msg);
    const okType = /\.(mp4|mov|m4v)$/i.test(f.name) || f.type.startsWith('video/');
    if (!okType) {
      showMsg(msg, '영상 파일(mp4 또는 mov)을 골라 주세요.');
      return;
    }
    $('fileName').textContent = `불러오는 중… ${f.name}`;
    let src: VideoSource;
    try {
      src = await VideoSource.fromFile(f);
    } catch {
      $('fileName').textContent = '';
      showMsg(
        msg,
        '이 브라우저에서 영상을 열 수 없어요. 크롬이나 사파리 최신 버전을 쓰거나, 아이폰은 설정 > 카메라 > 포맷에서 ‘높은 호환성’으로 다시 찍어 보세요.',
      );
      return;
    }
    const fps = await readFpsFromFile(f);
    setSource(src, fps, false);
    $('fileName').textContent = `${f.name} · ${src.width}×${src.height} 화소 · ${src.duration.toFixed(2)}초`;
  });

  fpsInput.addEventListener('change', () => {
    const v = parseNum(fpsInput);
    if (!(v > 0 && v <= 1000)) {
      showMsg(msg, 'fps는 1보다 큰 숫자로 적어 주세요. 보통 30 또는 60이에요.', 'warn');
      fpsInput.value = String(state.fps);
      return;
    }
    hideMsg(msg);
    state.fps = v;
    $('fpsNote').textContent = '직접 입력한 값이에요.';
    resetDownstream();
    updateFrameUi();
  });

  $('prev1').addEventListener('click', () => stepFrame(-1));
  $('next1').addEventListener('click', () => stepFrame(1));
  $('play1').addEventListener('click', togglePlay);
  $<HTMLInputElement>('seek1').addEventListener('input', (e) => goFrame(Number((e.target as HTMLInputElement).value)));
}

/** 새 영상(또는 데모)을 쓰기 시작 */
export function setSource(src: FrameSource, fps: number | null, isDemo: boolean) {
  state.source?.dispose();
  state.source = src;
  state.isDemo = isDemo;
  state.frame = 0;
  state.ruler = { a: null, b: null, mm: null };
  state.roi = null;
  resetDownstream();
  const fpsInput = $<HTMLInputElement>('fpsInput');
  const note = $('fpsNote');
  if (fps && fps > 0) {
    state.fps = fps;
    note.textContent = isDemo ? '데모 영상은 30 fps예요.' : '영상 파일에서 자동으로 읽었어요.';
  } else {
    state.fps = 30;
    note.textContent = '자동으로 읽지 못했어요. 촬영 설정을 보고 직접 적어 주세요 (보통 30 또는 60).';
  }
  fpsInput.value = String(state.fps);
  $('player1').hidden = false;
  hideMsg($('msg1'));
  goFrame(0);
  emit('source');
}

function resetDownstream() {
  state.track = null;
  state.samples = [];
  state.sampleIdx = 0;
  state.manualSegment = null;
  emit('track');
}

export function goFrame(n: number) {
  const s = state.source;
  if (!s) return;
  const max = frameCount() - 1;
  state.frame = Math.max(0, Math.min(max, Math.round(n)));
  s.seekTime((state.frame + 0.5) / state.fps).then(() => {
    viewer.render();
    emit('frame');
  });
  updateFrameUi();
}

export function stepFrame(d: number) {
  if (state.source?.playing) togglePlay();
  goFrame(state.frame + d);
}

function togglePlay() {
  const s = state.source;
  if (!s) return;
  const btn = $('play1');
  if (s.playing) {
    s.pause();
    btn.textContent = '재생';
    goFrame(Math.floor(s.currentTime * state.fps));
    return;
  }
  btn.textContent = '정지';
  s.play(() => {
    viewer.render();
    state.frame = Math.min(frameCount() - 1, Math.floor(s.currentTime * state.fps));
    updateFrameUi();
    if (!s.playing) btn.textContent = '재생';
  });
}

function updateFrameUi() {
  const n = frameCount();
  const seek = $<HTMLInputElement>('seek1');
  seek.max = String(Math.max(0, n - 1));
  seek.value = String(state.frame);
  $('frameInfo1').textContent = `프레임 ${state.frame + 1} / ${n} · 시간 ${(state.frame / state.fps).toFixed(3)} s`;
}

export function renderStep1() {
  if (state.source) {
    viewer.render();
    updateFrameUi();
  }
}
