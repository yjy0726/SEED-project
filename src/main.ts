import 'pretendard/dist/web/variable/pretendardvariable-dynamic-subset.css';
import './style.css';
import { loadPersisted, pxPerMm, samplePoint, state } from './state';
import { $, hideMsg, isTyping, showMsg } from './ui/dom';
import { initStep1, renderStep1, stepFrame } from './ui/step1';
import { initStep2, renderStep2 } from './ui/step2';
import { initStep3, renderStep3, stepSample } from './ui/step3';
import { initStep4, renderStep4 } from './ui/step4';
import { loadDemo } from './demo';

let current = 0;

/** 그 단계로 가도 되는지 검사. 안 되면 쉬운 말로 이유를 돌려줌 */
function blocker(step: number): { msg: string; back: number } | null {
  if (step >= 2 && !state.source) return { msg: '먼저 1단계에서 영상을 불러오거나, 위의 ‘데모 불러오기’를 눌러 주세요.', back: 1 };
  if (step >= 3) {
    if (!pxPerMm()) return { msg: '축척이 아직 없어요. 2단계에서 자 위의 두 점을 찍고 실제 길이(mm)를 입력해 주세요.', back: 2 };
    if (!state.roi) return { msg: '수로 영역이 아직 없어요. 2단계에서 ‘수로 영역 그리기’로 물길을 사각형으로 감싸 주세요.', back: 2 };
  }
  if (step >= 4) {
    const ok = state.samples.filter((s) => samplePoint(s)).length;
    if (ok < 10) return { msg: '보트 위치 데이터가 부족해요. 3단계에서 ‘자동 추적 시작’을 눌러 주세요.', back: 3 };
  }
  return null;
}

export function goStep(step: number) {
  const b = blocker(step);
  // 4단계는 영상 없이도 기록·표준곡선을 볼 수 있게 허용 (경고만 표시)
  const softAllow4 = step === 4 && b !== null;
  if (b && !softAllow4) {
    const target = Math.min(b.back, current);
    showStep(target);
    showMsg($(`msg${target}`), b.msg, 'warn');
    return;
  }
  showStep(step);
  if (softAllow4) showMsg($('msg4'), `${b!.msg} (측정 기록과 표준곡선은 아래에서 바로 쓸 수 있어요.)`, 'warn');
}

function showStep(step: number) {
  if (state.source?.playing) state.source.pause();
  current = step;
  document.querySelectorAll<HTMLElement>('section.step').forEach((s) => (s.hidden = Number(s.dataset.step) !== step));
  document.querySelectorAll<HTMLButtonElement>('.step-tab').forEach((t) => {
    const n = Number(t.dataset.step);
    if (n === step) t.setAttribute('aria-current', 'step');
    else t.removeAttribute('aria-current');
    t.classList.toggle('done', n < step || (n !== step && !blocker(n + 1) && n < 4));
  });
  for (let i = 1; i <= 4; i++) hideMsg($(`msg${i}`));
  if (step === 0 && location.hash.startsWith('#th-')) return;
  if (step === 1) renderStep1();
  if (step === 2) renderStep2();
  if (step === 3) renderStep3();
  if (step === 4) renderStep4();
  window.scrollTo({ top: 0 });
}

function init() {
  loadPersisted();
  initStep1();
  initStep2();
  initStep3();
  initStep4();

  document.querySelectorAll<HTMLButtonElement>('.step-tab').forEach((t) =>
    t.addEventListener('click', () => goStep(Number(t.dataset.step))),
  );
  document.querySelectorAll<HTMLButtonElement>('[data-goto]').forEach((b) =>
    b.addEventListener('click', () => goStep(Number(b.dataset.goto))),
  );
  // 이론 목차: 해당 절로 부드럽게 이동
  document.querySelectorAll<HTMLAnchorElement>('.th-toc a').forEach((a) =>
    a.addEventListener('click', (e) => {
      const el = document.querySelector(a.getAttribute('href') ?? '');
      if (!el) return;
      e.preventDefault();
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }),
  );
  $('btnDemo2').addEventListener('click', () => $('btnDemo').click());
  // 지금 읽는 절을 목차에 표시
  const tocLinks = new Map<string, HTMLAnchorElement>();
  document.querySelectorAll<HTMLAnchorElement>('.th-toc a').forEach((a) => tocLinks.set((a.getAttribute('href') ?? '').slice(1), a));
  if ('IntersectionObserver' in window) {
    const seen = new Set<string>();
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) e.isIntersecting ? seen.add(e.target.id) : seen.delete(e.target.id);
        const first = [...document.querySelectorAll<HTMLElement>('.th')].find((el) => seen.has(el.id));
        tocLinks.forEach((a, id) => a.setAttribute('aria-current', String(first?.id === id)));
      },
      { rootMargin: '-140px 0px -55% 0px' },
    );
    document.querySelectorAll<HTMLElement>('.th').forEach((el) => io.observe(el));
  }
  $('btnDemo').addEventListener('click', async () => {
    await loadDemo();
    showStep(1);
    showMsg($('msg1'), '데모를 불러왔어요. 합성 영상과 측정 기록 예시가 들어 있어요. 축척과 수로 영역도 미리 정해 두었으니 단계를 차례로 눌러 보세요.', 'ok');
  });

  // 좌우 방향키: 1·2단계는 프레임, 3단계는 분석 프레임 이동
  window.addEventListener('keydown', (e) => {
    if (isTyping(e) || e.altKey || e.ctrlKey || e.metaKey) return;
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    const d = e.key === 'ArrowLeft' ? -1 : 1;
    const big = e.shiftKey ? 10 : 1;
    if (current === 1 || current === 2) {
      e.preventDefault();
      stepFrame(d * big);
    } else if (current === 3) {
      e.preventDefault();
      stepSample(d * big);
    }
  });

  let resizeTimer = 0;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(() => showStepRender(), 150);
  });

  showStep(0);
}

function showStepRender() {
  if (current === 1) renderStep1();
  if (current === 2) renderStep2();
  if (current === 3) renderStep3();
}

init();
