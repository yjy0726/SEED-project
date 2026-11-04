import type { StdPoint } from './calibration';

type Cell = string | number | null | undefined;

function esc(c: Cell): string {
  if (c === null || c === undefined) return '';
  const s = typeof c === 'number' ? (isFinite(c) ? String(c) : '') : c;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** 2차원 배열 → CSV 문자열 (엑셀에서 한글이 깨지지 않도록 BOM 포함) */
export function toCSV(rows: Cell[][], withBom = true): string {
  const body = rows.map((r) => r.map(esc).join(',')).join('\r\n');
  return (withBom ? '﻿' : '') + body + '\r\n';
}

/** CSV 문자열 → 2차원 배열. 따옴표, 쉼표/세미콜론/탭 구분자 지원 */
export function parseCSV(text: string): string[][] {
  const src = text.replace(/^﻿/, '');
  const firstLine = src.split(/\r?\n/, 1)[0] ?? '';
  const delim = firstLine.includes('\t') ? '\t' : firstLine.includes(';') && !firstLine.includes(',') ? ';' : ',';
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQ = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQ) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i++;
        } else inQ = false;
      } else cell += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === delim) {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  if (cell !== '' || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

function num(s: string | undefined): number {
  if (s === undefined) return NaN;
  const t = s.trim().replace(/,/g, '.');
  return t === '' ? NaN : Number(t);
}

/**
 * 표준곡선 CSV 읽기. 첫 두 열 = 농도(mg/L), v/v0.
 * 첫 줄이 숫자가 아니면 제목 줄로 보고 건너뛴다.
 */
export function parseStandardCSV(text: string): { points: StdPoint[]; skipped: number } {
  const rows = parseCSV(text);
  const points: StdPoint[] = [];
  let skipped = 0;
  rows.forEach((r, i) => {
    const c = num(r[0]);
    const v = num(r[1]);
    if (isFinite(c) && isFinite(v) && c >= 0) points.push({ conc: c, ratio: v });
    else if (i > 0) skipped++;
  });
  return { points, skipped };
}
