import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { fpsFromMoov, readFpsFromFile } from '../src/lib/mp4fps';

const fixture = (name: string) => readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)));

describe('MP4/MOV fps 읽기', () => {
  it('25 fps mp4 (moov가 파일 끝)', async () => {
    expect(await readFpsFromFile(new Blob([fixture('fps25.mp4')]))).toBe(25);
  });
  it('29.97 fps mov', async () => {
    expect(await readFpsFromFile(new Blob([fixture('fps2997.mov')]))).toBeCloseTo(29.97, 2);
  });
  it('60 fps mp4 (moov가 파일 앞, faststart)', async () => {
    expect(await readFpsFromFile(new Blob([fixture('fps60_faststart.mp4')]))).toBe(60);
  });
  it('영상이 아닌 파일이면 null', async () => {
    expect(await readFpsFromFile(new Blob([new Uint8Array(100)]))).toBeNull();
    expect(await readFpsFromFile(new Blob(['hello world, not a video']))).toBeNull();
    expect(fpsFromMoov(new ArrayBuffer(4))).toBeNull();
  });
});
