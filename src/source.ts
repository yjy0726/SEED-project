import { rgbaToGray } from './lib/tracking';
import { demuxFile, type DemuxTrack } from './lib/mp4demux';
import { codedRectFor, sampleLuma } from './lib/luma';
import { positionAt, rng, type MotionProfile } from './lib/synthetic';
import type { Rect } from './state';

export interface GrabResult {
  times: number[];
  frames: Uint8Array[];
}

/** auto: 빠른 방법부터 차례로 시도, seek: 프레임마다 하나씩 찾아가기(느리지만 호환성 최고) */
export type GrabMode = 'auto' | 'seek';

/** 영상 프레임을 주는 공통 인터페이스 (실제 영상 / 데모 합성 영상) */
export interface FrameSource {
  kind: 'video' | 'demo';
  name: string;
  width: number;
  height: number;
  duration: number;
  /** 현재 프레임 그림 (canvas drawImage 에 바로 쓸 수 있음) */
  readonly image: CanvasImageSource;
  readonly currentTime: number;
  seekTime(t: number): Promise<void>;
  play(onFrame: () => void): void;
  pause(): void;
  readonly playing: boolean;
  /** 마지막 분석에 쓴 프레임 읽기 방법 */
  lastMethod?: string;
  grab(roi: Rect, outW: number, outH: number, mode: GrabMode, fps: number, onProgress: (p: number) => void): Promise<GrabResult>;
  dispose(): void;
}

function makeWorkCanvas(w: number, h: number) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  return { c, ctx };
}

const nextTick = () => new Promise<void>((r) => setTimeout(r, 0));

// ═════════════════ 실제 영상 ═════════════════
export class VideoSource implements FrameSource {
  kind = 'video' as const;
  width = 0;
  height = 0;
  duration = 0;
  private chain: Promise<void> = Promise.resolve();
  private wanted = 0;
  private playingFlag = false;
  private rafId = 0;

  /** 마지막 분석에 쓴 방법 (화면 표시용) */
  lastMethod = '';
  private demux: DemuxTrack | null | undefined;

  private constructor(public name: string, private video: HTMLVideoElement, private url: string, private file: File) {}

  get image() {
    return this.video;
  }
  get currentTime() {
    return this.video.currentTime;
  }
  get playing() {
    return this.playingFlag;
  }

  static async fromFile(file: File): Promise<VideoSource> {
    const url = URL.createObjectURL(file);
    const v = document.createElement('video');
    v.muted = true;
    v.playsInline = true;
    v.setAttribute('playsinline', '');
    v.preload = 'auto';
    // 일부 브라우저(사파리)는 화면에 붙어 있어야 프레임을 그려 줌 → 보이지 않게 붙여 둠
    v.style.cssText = 'position:fixed;left:0;top:0;width:2px;height:2px;opacity:0;pointer-events:none;';
    document.body.appendChild(v);
    const src = new VideoSource(file.name, v, url, file);
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timeout')), 20000);
        v.addEventListener('loadeddata', () => { clearTimeout(timer); resolve(); }, { once: true });
        v.addEventListener('error', () => { clearTimeout(timer); reject(new Error('decode')); }, { once: true });
        v.src = url;
        v.load();
      });
    } catch (e) {
      src.dispose();
      throw e;
    }
    if (!v.videoWidth || !v.videoHeight || !isFinite(v.duration)) {
      src.dispose();
      throw new Error('decode');
    }
    src.width = v.videoWidth;
    src.height = v.videoHeight;
    src.duration = v.duration;
    return src;
  }

  /** 여러 번 빠르게 불러도 마지막 요청만 실제로 이동 */
  seekTime(t: number): Promise<void> {
    this.wanted = Math.max(0, Math.min(this.duration - 1e-3, t));
    this.chain = this.chain.then(() => this.doSeek(this.wanted));
    return this.chain;
  }

  private doSeek(t: number): Promise<void> {
    const v = this.video;
    if (Math.abs(v.currentTime - t) < 1e-6 && !v.seeking) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const timer = setTimeout(done, 4000);
      function done() {
        clearTimeout(timer);
        v.removeEventListener('seeked', done);
        resolve();
      }
      v.addEventListener('seeked', done);
      v.currentTime = t;
    });
  }

  play(onFrame: () => void) {
    if (this.playingFlag) return;
    this.playingFlag = true;
    const v = this.video;
    v.playbackRate = 1;
    if (v.ended || v.currentTime >= this.duration - 0.05) v.currentTime = 0;
    v.play().catch(() => (this.playingFlag = false));
    const loop = () => {
      onFrame();
      if (v.paused || v.ended) {
        this.playingFlag = false;
        onFrame();
        return;
      }
      this.rafId = requestAnimationFrame(loop);
    };
    this.rafId = requestAnimationFrame(loop);
  }

  pause() {
    this.video.pause();
    this.playingFlag = false;
    cancelAnimationFrame(this.rafId);
  }

  async grab(roi: Rect, outW: number, outH: number, mode: GrabMode, fps: number, onProgress: (p: number) => void): Promise<GrabResult> {
    this.pause();
    if (mode === 'auto') {
      // 1순위: 브라우저 내장 디코더(WebCodecs)로 재생 없이 모든 프레임을 빠르게 풀기
      try {
        const r = await this.grabByDecoder(roi, outW, outH, onProgress);
        if (r) {
          this.lastMethod = '내장 디코더';
          return r;
        }
      } catch {
        /* 다음 방법으로 */
      }
      // 2순위: 4배속 재생하며 프레임 받기 (일부 프레임은 건너뛸 수 있음)
      if ('requestVideoFrameCallback' in HTMLVideoElement.prototype) {
        try {
          const r = await this.grabByPlayback(roi, outW, outH, fps, onProgress);
          if (r.frames.length >= Math.min(20, this.duration * fps * 0.2)) {
            this.lastMethod = '빠른 재생';
            return r;
          }
        } catch {
          /* 다음 방법으로 */
        }
      }
    }
    this.lastMethod = '프레임별 탐색';
    return this.grabBySeeking(roi, outW, outH, fps, onProgress);
  }

  /** WebCodecs: MP4 안의 압축 프레임을 직접 꺼내 디코더에 넣는다. 지원 안 되면 null */
  private async grabByDecoder(roi: Rect, outW: number, outH: number, onProgress: (p: number) => void): Promise<GrabResult | null> {
    if (typeof VideoDecoder === 'undefined' || typeof EncodedVideoChunk === 'undefined') return null;
    if (this.demux === undefined) this.demux = await demuxFile(this.file);
    const tr = this.demux;
    if (!tr || tr.samples.length === 0) return null;
    const rot = tr.rotation;
    if (rot % 90 !== 0) return null;
    // 회전 정보가 <video> 화면 크기와 맞는지 확인
    const sideways = rot === 90 || rot === 270;
    const dispW = sideways ? tr.codedHeight : tr.codedWidth;
    const dispH = sideways ? tr.codedWidth : tr.codedHeight;
    if (Math.abs(dispW - this.width) > 16 || Math.abs(dispH - this.height) > 16) return null;

    const config: VideoDecoderConfig = {
      codec: tr.codec,
      codedWidth: tr.codedWidth,
      codedHeight: tr.codedHeight,
      ...(tr.description ? { description: tr.description } : {}),
    };
    const support = await VideoDecoder.isConfigSupported(config).catch(() => null);
    if (!support?.supported) return null;

    let start = Infinity;
    let end = 0;
    for (const s of tr.samples) {
      start = Math.min(start, s.offset);
      end = Math.max(end, s.offset + s.size);
    }
    if (end - start > 600 * 1024 * 1024) return null;
    const data = new Uint8Array(await this.file.slice(start, end).arrayBuffer());

    const { ctx } = makeWorkCanvas(outW, outH);
    const sx = outW / roi.w;
    const sy = outH / roi.h;
    const out: { t: number; g: Uint8Array }[] = [];
    let failed = false;
    // 빠른 길: 밝기(Y) 평면에서 수로 영역만 복사 → RGB 변환과 캔버스 그리기를 건너뜀
    const LUMA_FORMATS = new Set(['I420', 'I420A', 'I422', 'I444', 'NV12']);
    let pending: Promise<void> = Promise.resolve();
    let pendingCount = 0;
    let lumaBuf: Uint8Array | null = null;
    const drawSlow = (f: VideoFrame) => {
      const W0 = f.displayWidth;
      const H0 = f.displayHeight;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, outW, outH);
      ctx.setTransform(sx, 0, 0, sy, -roi.x * sx, -roi.y * sy);
      if (rot === 90) ctx.transform(0, 1, -1, 0, H0, 0);
      else if (rot === 180) ctx.transform(-1, 0, 0, -1, W0, H0);
      else if (rot === 270) ctx.transform(0, -1, 1, 0, 0, W0);
      ctx.drawImage(f, 0, 0, W0, H0);
      return rgbaToGray(ctx.getImageData(0, 0, outW, outH).data);
    };
    const handle = async (f: VideoFrame) => {
      try {
        const t = f.timestamp / 1e6;
        const vr = f.visibleRect;
        if (f.format && LUMA_FORMATS.has(f.format) && vr) {
          const W0 = vr.width;
          const H0 = vr.height;
          const r = codedRectFor(roi, rot, W0, H0);
          const rect = { x: vr.x + r.x, y: vr.y + r.y, width: r.w, height: r.h };
          const size = f.allocationSize({ rect });
          if (!lumaBuf || lumaBuf.length !== size) lumaBuf = new Uint8Array(size);
          const layout = await f.copyTo(lumaBuf, { rect });
          const yPlane = lumaBuf.subarray(layout[0].offset);
          const stride = layout[0].stride;
          // stride 가 너비와 다르면 한 줄씩 모아서 촘촘하게
          let plane = yPlane;
          if (stride !== r.w) {
            plane = new Uint8Array(r.w * r.h);
            for (let y = 0; y < r.h; y++) plane.set(yPlane.subarray(y * stride, y * stride + r.w), y * r.w);
          }
          out.push({ t, g: sampleLuma(plane, r.w, r.h, r.x, r.y, rot, W0, H0, roi, outW, outH) });
        } else {
          out.push({ t, g: drawSlow(f) });
        }
      } catch {
        try {
          out.push({ t: f.timestamp / 1e6, g: drawSlow(f) });
        } catch {
          failed = true;
        }
      } finally {
        f.close();
        pendingCount--;
      }
    };
    const decoder = new VideoDecoder({
      output: (f) => {
        pendingCount++;
        pending = pending.then(() => handle(f));
      },
      error: () => {
        failed = true;
      },
    });
    decoder.configure(config);
    const n = tr.samples.length;
    for (let i = 0; i < n && !failed; i++) {
      const s = tr.samples[i];
      decoder.decode(
        new EncodedVideoChunk({
          type: s.key ? 'key' : 'delta',
          timestamp: s.timestampUs,
          data: data.subarray(s.offset - start, s.offset - start + s.size),
        }),
      );
      while (pendingCount > 6 && !failed) await pending;
      if (decoder.decodeQueueSize > 12) {
        await new Promise<void>((r) => {
          const t = setTimeout(r, 200);
          decoder.addEventListener('dequeue', () => { clearTimeout(t); r(); }, { once: true });
        });
      }
      if (i % 15 === 0) onProgress((0.9 * i) / n);
    }
    if (!failed) await decoder.flush().catch(() => (failed = true));
    await pending;
    if (decoder.state !== 'closed') decoder.close();
    if (failed || out.length < n * 0.9) return null;
    out.sort((a, b) => a.t - b.t);
    return { times: out.map((o) => o.t), frames: out.map((o) => o.g) };
  }

  /** 빠른 방식: 4배속으로 재생하면서 화면에 나오는 프레임을 모두 받아 둔다 (시간은 영상 속 실제 시간) */
  private async grabByPlayback(roi: Rect, outW: number, outH: number, fps: number, onProgress: (p: number) => void): Promise<GrabResult> {
    const v = this.video as HTMLVideoElement & {
      requestVideoFrameCallback(cb: (now: number, meta: { mediaTime: number }) => void): number;
    };
    const { ctx } = makeWorkCanvas(outW, outH);
    const times: number[] = [];
    const frames: Uint8Array[] = [];
    const capture = (t: number) => {
      if (times.length && t <= times[times.length - 1] + 1e-6) return;
      ctx.drawImage(v, roi.x, roi.y, roi.w, roi.h, 0, 0, outW, outH);
      frames.push(rgbaToGray(ctx.getImageData(0, 0, outW, outH).data));
      times.push(t);
    };
    await this.seekTime(0);
    capture(0);
    v.playbackRate = 4;
    await new Promise<void>((resolve, reject) => {
      let finished = false;
      let lastCb = performance.now();
      const finish = () => {
        if (finished) return;
        finished = true;
        clearInterval(watchdog);
        v.pause();
        v.playbackRate = 1;
        resolve();
      };
      const watchdog = setInterval(() => {
        if (performance.now() - lastCb > 2500) {
          finished = true;
          clearInterval(watchdog);
          v.pause();
          v.playbackRate = 1;
          reject(new Error('stalled'));
        }
      }, 500);
      const cb = (_now: number, meta: { mediaTime: number }) => {
        if (finished) return;
        lastCb = performance.now();
        capture(meta.mediaTime);
        onProgress(Math.min(1, meta.mediaTime / this.duration));
        if (v.ended || meta.mediaTime >= this.duration - 1.5 / fps) finish();
        else v.requestVideoFrameCallback(cb);
      };
      v.requestVideoFrameCallback(cb);
      v.addEventListener('ended', () => setTimeout(finish, 80), { once: true });
      v.play().catch(reject);
    });
    return { times, frames };
  }

  /** 정확한 방식: 모든 프레임을 하나씩 찾아가서 읽는다 */
  private async grabBySeeking(roi: Rect, outW: number, outH: number, fps: number, onProgress: (p: number) => void): Promise<GrabResult> {
    const { ctx } = makeWorkCanvas(outW, outH);
    const n = Math.max(1, Math.floor(this.duration * fps + 1e-6));
    const times: number[] = [];
    const frames: Uint8Array[] = [];
    for (let i = 0; i < n; i++) {
      await this.seekTime((i + 0.5) / fps);
      ctx.drawImage(this.video, roi.x, roi.y, roi.w, roi.h, 0, 0, outW, outH);
      frames.push(rgbaToGray(ctx.getImageData(0, 0, outW, outH).data));
      times.push(i / fps);
      if (i % 5 === 0) onProgress(i / n);
    }
    return { times, frames };
  }

  dispose() {
    this.pause();
    this.video.removeAttribute('src');
    this.video.load();
    this.video.remove();
    URL.revokeObjectURL(this.url);
  }
}

// ═════════════════ 데모 합성 영상 ═════════════════
/** 데모 장면 설정 (영상 화소) */
export const DEMO = {
  width: 640,
  height: 360,
  fps: 30,
  duration: 10,
  /** 자 눈금: 0 mm 위치와 2 px/mm */
  ruler0: 60,
  pxPerMm: 2,
  rulerY: 262,
  channel: { x: 40, y: 140, w: 560, h: 84 },
  boatStartX: 84,
  boatY: 182,
  profile: { v: 18.4, tStart: 0.8, accel: 1.2, tDecel: 8.0, decel: 1.2 } as MotionProfile,
};

export class DemoSource implements FrameSource {
  kind = 'demo' as const;
  name = '데모 영상 (합성) – 하천수 A';
  width = DEMO.width;
  height = DEMO.height;
  duration = DEMO.duration;
  private t = 0;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private base: HTMLCanvasElement;
  private playingFlag = false;
  private rafId = 0;

  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.width = DEMO.width;
    this.canvas.height = DEMO.height;
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true })!;
    this.base = this.drawBase();
    this.render();
  }

  get image() {
    return this.canvas;
  }
  get currentTime() {
    return this.t;
  }
  get playing() {
    return this.playingFlag;
  }

  /** 시각 t 에서 보트 중심 (영상 화소) – 정답 확인용 */
  static boatAt(t: number) {
    const x = DEMO.boatStartX + positionAt(DEMO.profile, t) * DEMO.pxPerMm;
    const y = DEMO.boatY + 1.2 * Math.sin(t * 2.1);
    return { x, y };
  }

  private drawBase(): HTMLCanvasElement {
    const c = document.createElement('canvas');
    c.width = DEMO.width;
    c.height = DEMO.height;
    const g = c.getContext('2d')!;
    // 책상
    g.fillStyle = '#d8d4cc';
    g.fillRect(0, 0, c.width, c.height);
    const r = rng(42);
    for (let i = 0; i < 2500; i++) {
      g.fillStyle = `rgba(80,70,60,${0.03 + r() * 0.05})`;
      g.fillRect(r() * c.width, r() * c.height, 2, 2);
    }
    // 수로 (아크릴 통)
    const ch = DEMO.channel;
    g.fillStyle = '#9aa3ad';
    g.fillRect(ch.x - 6, ch.y - 6, ch.w + 12, ch.h + 12);
    const grad = g.createLinearGradient(0, ch.y, 0, ch.y + ch.h);
    grad.addColorStop(0, '#3f6f99');
    grad.addColorStop(0.5, '#4a7ca8');
    grad.addColorStop(1, '#3c6a93');
    g.fillStyle = grad;
    g.fillRect(ch.x, ch.y, ch.w, ch.h);
    // 자
    const y = DEMO.rulerY;
    g.fillStyle = '#f3e7b3';
    g.fillRect(DEMO.ruler0 - 14, y - 16, 250 * DEMO.pxPerMm + 28, 46);
    g.strokeStyle = '#222';
    g.fillStyle = '#222';
    g.font = '10px sans-serif';
    g.textAlign = 'center';
    for (let mm = 0; mm <= 250; mm++) {
      const x = DEMO.ruler0 + mm * DEMO.pxPerMm + 0.5;
      const len = mm % 10 === 0 ? 14 : mm % 5 === 0 ? 9 : 5;
      g.beginPath();
      g.moveTo(x, y - 16);
      g.lineTo(x, y - 16 + len);
      g.lineWidth = mm % 10 === 0 ? 1 : 0.6;
      g.stroke();
      if (mm % 20 === 0) g.fillText(String(mm / 10), x, y + 12);
    }
    g.fillText('cm', DEMO.ruler0 + 250 * DEMO.pxPerMm + 2, y + 25);
    return c;
  }

  private render() {
    const g = this.ctx;
    const t = this.t;
    g.drawImage(this.base, 0, 0);
    // 물결 반짝임 (매 프레임 조금씩 다름)
    const fi = Math.round(t * DEMO.fps);
    const r = rng(1000 + fi);
    const ch = DEMO.channel;
    for (let i = 0; i < 120; i++) {
      g.fillStyle = `rgba(255,255,255,${0.04 + r() * 0.06})`;
      g.fillRect(ch.x + r() * ch.w, ch.y + r() * ch.h, 3 + r() * 5, 1.5);
    }
    // 보트 (위에서 본 모습, 오른쪽이 앞)
    const { x, y } = DemoSource.boatAt(t);
    g.save();
    g.translate(x, y);
    g.fillStyle = '#f7f7f2';
    g.strokeStyle = '#c9c9c0';
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(-13, -8);
    g.lineTo(6, -8);
    g.lineTo(14, 0);
    g.lineTo(6, 8);
    g.lineTo(-13, 8);
    g.closePath();
    g.fill();
    g.stroke();
    // 뒤쪽 장뇌 조각
    g.fillStyle = '#ffffff';
    g.fillRect(-17, -4, 6, 8);
    g.restore();
    // 센서 잡음
    for (let i = 0; i < 300; i++) {
      g.fillStyle = r() < 0.5 ? 'rgba(0,0,0,0.06)' : 'rgba(255,255,255,0.06)';
      g.fillRect(r() * DEMO.width, r() * DEMO.height, 1, 1);
    }
  }

  seekTime(t: number): Promise<void> {
    this.t = Math.max(0, Math.min(this.duration - 1e-3, t));
    this.render();
    return Promise.resolve();
  }

  play(onFrame: () => void) {
    if (this.playingFlag) return;
    this.playingFlag = true;
    if (this.t >= this.duration - 0.05) this.t = 0;
    let last = performance.now();
    const loop = (now: number) => {
      if (!this.playingFlag) return;
      this.t += (now - last) / 1000;
      last = now;
      if (this.t >= this.duration - 1e-3) {
        this.t = this.duration - 1e-3;
        this.playingFlag = false;
      }
      this.render();
      onFrame();
      if (this.playingFlag) this.rafId = requestAnimationFrame(loop);
    };
    this.rafId = requestAnimationFrame(loop);
  }

  pause() {
    this.playingFlag = false;
    cancelAnimationFrame(this.rafId);
  }

  async grab(roi: Rect, outW: number, outH: number, _mode: GrabMode, fps: number, onProgress: (p: number) => void): Promise<GrabResult> {
    this.pause();
    const { ctx } = makeWorkCanvas(outW, outH);
    const n = Math.floor(this.duration * fps + 1e-6);
    const times: number[] = [];
    const frames: Uint8Array[] = [];
    for (let i = 0; i < n; i++) {
      this.t = i / fps;
      this.render();
      ctx.drawImage(this.canvas, roi.x, roi.y, roi.w, roi.h, 0, 0, outW, outH);
      frames.push(rgbaToGray(ctx.getImageData(0, 0, outW, outH).data));
      times.push(i / fps);
      if (i % 30 === 0) {
        onProgress(i / n);
        await nextTick();
      }
    }
    return { times, frames };
  }

  dispose() {
    this.pause();
  }
}
