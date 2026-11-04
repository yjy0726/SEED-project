import { describe, expect, it } from 'vitest';
import { parseCSV, parseStandardCSV, toCSV } from '../src/lib/csv';

describe('CSV', () => {
  it('쓰기 → 읽기 왕복 (따옴표·쉼표·줄바꿈 포함)', () => {
    const rows = [['이름', '값'], ['하천수, "A"', 1.5], ['줄\n바꿈', -2]];
    const text = toCSV(rows);
    expect(text.startsWith('﻿')).toBe(true);
    expect(parseCSV(text)).toEqual([['이름', '값'], ['하천수, "A"', '1.5'], ['줄\n바꿈', '-2']]);
  });
  it('표준곡선 CSV: 제목 줄 건너뛰기, 탭/세미콜론 구분', () => {
    expect(parseStandardCSV('농도(mg/L),v/v0\n0,1\n1,0.9\n').points).toEqual([
      { conc: 0, ratio: 1 },
      { conc: 1, ratio: 0.9 },
    ]);
    expect(parseStandardCSV('0\t1\n2\t0.8').points).toHaveLength(2);
    expect(parseStandardCSV('0;1\n2;0,8').points[1]).toEqual({ conc: 2, ratio: 0.8 });
    const bad = parseStandardCSV('c,r\n1,0.9\nabc,1\n');
    expect(bad.points).toHaveLength(1);
    expect(bad.skipped).toBe(1);
  });
});
