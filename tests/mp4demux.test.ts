import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { demuxFile } from '../src/lib/mp4demux';

const blob = (name: string) => new Blob([readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)))]);

describe('MP4/MOV 분해기 (WebCodecs 용)', () => {
  it('H.264 mp4: 25프레임, 첫 프레임은 키프레임, 시간 간격 0.04 s', async () => {
    const t = (await demuxFile(blob('fps25.mp4')))!;
    expect(t.codec).toMatch(/^avc1\.[0-9a-f]{6}$/);
    expect(t.description!.length).toBeGreaterThan(5);
    expect(t.codedWidth).toBe(64);
    expect(t.codedHeight).toBe(48);
    expect(t.samples).toHaveLength(25);
    expect(t.samples[0].key).toBe(true);
    const times = t.samples.map((s) => s.time).sort((a, b) => a - b);
    expect(times[0]).toBe(0);
    expect(times[1]).toBeCloseTo(0.04, 6);
    // 파일 안에 실제 데이터가 있는 위치여야 함
    for (const s of t.samples) expect(s.offset + s.size).toBeLessThanOrEqual(3386);
  });
  it('MOV(29.97 fps)', async () => {
    const t = (await demuxFile(blob('fps2997.mov')))!;
    expect(t.codec.startsWith('avc1.')).toBe(true);
    expect(t.samples.length).toBeGreaterThanOrEqual(29);
  });
  it('B-프레임(표시 순서≠저장 순서)과 90° 회전 정보', async () => {
    const t = (await demuxFile(blob('bframes_rot90.mp4')))!;
    expect(t.samples).toHaveLength(30);
    const times = t.samples.map((s) => s.time);
    // 저장 순서로는 시간이 뒤섞여 있어야 함 (B-프레임)
    expect(times.some((v, i) => i > 0 && v < times[i - 1])).toBe(true);
    const sorted = [...times].sort((a, b) => a - b);
    sorted.forEach((v, i) => expect(v).toBeCloseTo(i / 30, 6));
    expect([90, 270]).toContain(t.rotation);
  });
  it('영상이 아니면 null', async () => {
    expect(await demuxFile(new Blob(['not a video file at all']))).toBeNull();
  });
});
