/** 작은 DOM 도우미들 */

export function $<T extends HTMLElement = HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} 요소가 없어요`);
  return el as T;
}

export type MsgKind = 'err' | 'warn' | 'ok';

export function showMsg(el: HTMLElement, text: string, kind: MsgKind = 'err') {
  el.textContent = text;
  el.className = `msg ${kind}`;
  el.hidden = false;
}

export function hideMsg(el: HTMLElement) {
  el.hidden = true;
  el.textContent = '';
}

let toastTimer = 0;
export function toast(text: string) {
  const el = $('toast');
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (el.hidden = true), 2600);
}

export function download(filename: string, text: string, mime = 'text/csv;charset=utf-8') {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** 숫자 표시 (NaN/무한대는 —) */
export function fmt(v: number | null | undefined, digits = 2): string {
  if (v === null || v === undefined || !isFinite(v)) return '—';
  return v.toFixed(digits);
}

/** 농도 표시: 작은 값은 자릿수를 더 */
export function fmtConc(c: number | null | undefined): string {
  if (c === null || c === undefined || !isFinite(c)) return '—';
  const a = Math.abs(c);
  return c.toFixed(a < 1 ? 3 : a < 100 ? 2 : 1);
}

export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);
}

export function parseNum(input: HTMLInputElement): number {
  const t = input.value.trim().replace(',', '.');
  return t === '' ? NaN : Number(t);
}

export function isTyping(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null;
  if (!t) return false;
  const tag = t.tagName;
  return tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || t.isContentEditable;
}

/**
 * 화면 안에 뜨는 확인 창 (브라우저 confirm() 대신).
 * 확인 → true, 취소/Esc/바깥 누름 → false
 */
export function askConfirm(message: string, okLabel = '확인', cancelLabel = '취소', danger = false): Promise<boolean> {
  return new Promise((resolve) => {
    const back = document.createElement('div');
    back.className = 'modal-back';
    back.innerHTML = `<div class="modal" role="dialog" aria-modal="true" aria-labelledby="modalText">
      <p id="modalText"></p>
      <div class="modal-actions">
        <button type="button" class="btn btn-small" data-v="0"></button>
        <button type="button" class="btn btn-small ${danger ? 'btn-danger-solid' : 'btn-primary'}" data-v="1"></button>
      </div></div>`;
    back.querySelector('#modalText')!.textContent = message;
    back.querySelector('[data-v="0"]')!.textContent = cancelLabel;
    back.querySelector('[data-v="1"]')!.textContent = okLabel;
    const prevFocus = document.activeElement as HTMLElement | null;
    const close = (v: boolean) => {
      window.removeEventListener('keydown', onKey, true);
      back.remove();
      prevFocus?.focus?.({ preventScroll: true });
      resolve(v);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        close(false);
      }
      e.stopPropagation();
    };
    back.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-v]');
      if (b) close(b.dataset.v === '1');
      else if (e.target === back) close(false);
    });
    window.addEventListener('keydown', onKey, true);
    document.body.appendChild(back);
    back.querySelector<HTMLButtonElement>('[data-v="1"]')!.focus();
  });
}
