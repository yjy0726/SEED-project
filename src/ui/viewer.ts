import type { Point } from '../lib/tracking';
import type { Rect } from '../state';
import type { FrameSource } from '../source';

export type Overlay = (ctx: CanvasRenderingContext2D, toCanvas: (p: Point) => Point, scale: number) => void;

/**
 * 캔버스에 영상 프레임(또는 그 일부 crop)을 그리고,
 * 화면 좌표 ↔ 영상 화소 좌표를 바꿔 주는 도우미.
 */
export class Viewer {
  ctx: CanvasRenderingContext2D;
  crop: Rect | null = null;
  overlay: Overlay | null = null;

  constructor(public canvas: HTMLCanvasElement, private getSource: () => FrameSource | null) {
    this.ctx = canvas.getContext('2d')!;
  }

  private region(): Rect | null {
    const s = this.getSource();
    if (!s) return null;
    return this.crop ?? { x: 0, y: 0, w: s.width, h: s.height };
  }

  /** 화면 너비에 맞춰 캔버스 해상도 조정 */
  resize() {
    const r = this.region();
    if (!r) return;
    const cssW = this.canvas.clientWidth || this.canvas.parentElement?.clientWidth || 640;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.round(cssW * dpr);
    const h = Math.round((w * r.h) / r.w);
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
  }

  /** 영상 화소 → 캔버스 화소 배율 */
  get scale(): number {
    const r = this.region();
    return r ? this.canvas.width / r.w : 1;
  }

  render() {
    const s = this.getSource();
    const r = this.region();
    if (!s || !r) return;
    this.resize();
    const { ctx, canvas } = this;
    ctx.imageSmoothingEnabled = true;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(s.image, r.x, r.y, r.w, r.h, 0, 0, canvas.width, canvas.height);
    if (this.overlay) this.overlay(ctx, (p) => this.toCanvas(p), this.scale);
  }

  toCanvas(p: Point): Point {
    const r = this.region()!;
    const k = this.scale;
    return { x: (p.x - r.x) * k, y: (p.y - r.y) * k };
  }

  /** 마우스/터치 위치 → 영상 화소 좌표 */
  toVideo(clientX: number, clientY: number): Point {
    const r = this.region()!;
    const b = this.canvas.getBoundingClientRect();
    const fx = (clientX - b.left) / b.width;
    const fy = (clientY - b.top) / b.height;
    return { x: r.x + fx * r.w, y: r.y + fy * r.h };
  }

  /** 확대경: 포인터 주변을 크게 보여 줌 */
  drawLoupe(center: Point, zoom = 4) {
    const s = this.getSource();
    if (!s) return;
    const { ctx, canvas } = this;
    const size = Math.round(Math.min(canvas.width, canvas.height) * 0.42);
    const k = this.scale * zoom;
    const half = size / 2 / k; // 영상 화소 단위 반경
    const c = this.toCanvas(center);
    // 포인터 반대쪽 위 모서리에 둔다
    const ox = c.x < canvas.width / 2 ? canvas.width - size - 8 : 8;
    const oy = 8;
    ctx.save();
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = '#fff';
    ctx.fillRect(ox - 2, oy - 2, size + 4, size + 4);
    ctx.drawImage(s.image, center.x - half, center.y - half, half * 2, half * 2, ox, oy, size, size);
    ctx.strokeStyle = '#1b2a5c';
    ctx.lineWidth = 2;
    ctx.strokeRect(ox, oy, size, size);
    ctx.beginPath();
    ctx.moveTo(ox + size / 2, oy);
    ctx.lineTo(ox + size / 2, oy + size);
    ctx.moveTo(ox, oy + size / 2);
    ctx.lineTo(ox + size, oy + size / 2);
    ctx.strokeStyle = 'rgba(224,112,30,0.95)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.restore();
  }
}
