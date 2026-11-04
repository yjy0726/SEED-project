/**
 * MP4 / MOV(QuickTime) 파일 머리말에서 영상 트랙의 fps 를 읽는다.
 * moov > trak > mdia > (hdlr 'vide', mdhd timescale) > minf > stbl > stts
 * fps = timescale × (전체 프레임 수) / (전체 프레임 길이 합)
 */

const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl']);

interface TrackInfo {
  isVideo: boolean;
  timescale: number;
  sampleCount: number;
  totalDelta: number;
}

function type4(v: DataView, o: number): string {
  return String.fromCharCode(v.getUint8(o), v.getUint8(o + 1), v.getUint8(o + 2), v.getUint8(o + 3));
}

function walk(v: DataView, start: number, end: number, cb: (type: string, body: number, end: number) => void) {
  let o = start;
  while (o + 8 <= end) {
    let size = v.getUint32(o);
    const type = type4(v, o + 4);
    let header = 8;
    if (size === 1) {
      if (o + 16 > end) return;
      size = Number(v.getBigUint64(o + 8));
      header = 16;
    } else if (size === 0) size = end - o;
    if (size < header || o + size > end) return;
    cb(type, o + header, o + size);
    o += size;
  }
}

/** moov 상자 내용(또는 moov 상자를 포함한 버퍼)에서 fps 를 구한다. */
export function fpsFromMoov(buf: ArrayBuffer): number | null {
  const v = new DataView(buf);
  const tracks: TrackInfo[] = [];
  let current: TrackInfo | null = null;

  const visit = (type: string, body: number, end: number) => {
    if (type === 'trak') {
      current = { isVideo: false, timescale: 0, sampleCount: 0, totalDelta: 0 };
      tracks.push(current);
    }
    if (CONTAINERS.has(type)) {
      walk(v, body, end, visit);
      return;
    }
    if (!current) return;
    const t: TrackInfo = current;
    if (type === 'hdlr' && body + 12 <= end) {
      t.isVideo = t.isVideo || type4(v, body + 8) === 'vide'; // minf 안의 두 번째 hdlr(dhlr)이 덮어쓰지 않도록
    } else if (type === 'mdhd') {
      const version = v.getUint8(body);
      const off = version === 1 ? body + 4 + 16 : body + 4 + 8;
      if (off + 4 <= end) t.timescale = v.getUint32(off);
    } else if (type === 'stts' && body + 8 <= end) {
      const count = v.getUint32(body + 4);
      for (let i = 0; i < count; i++) {
        const e = body + 8 + i * 8;
        if (e + 8 > end) break;
        const c = v.getUint32(e);
        t.sampleCount += c;
        t.totalDelta += c * v.getUint32(e + 4);
      }
    }
  };

  walk(v, 0, buf.byteLength, visit);
  const vid = tracks.find((t) => t.isVideo && t.timescale > 0 && t.totalDelta > 0);
  if (!vid) return null;
  const fps = (vid.timescale * vid.sampleCount) / vid.totalDelta;
  return isFinite(fps) && fps > 0 ? Math.round(fps * 1000) / 1000 : null;
}

/** File(Blob) 의 최상위 상자를 훑어 moov 만 읽어서 fps 를 구한다. 실패하면 null */
export async function readFpsFromFile(file: Blob): Promise<number | null> {
  try {
    let offset = 0;
    const size = file.size;
    for (let guard = 0; guard < 1000 && offset + 8 <= size; guard++) {
      const head = new DataView(await file.slice(offset, offset + 16).arrayBuffer());
      let boxSize = head.getUint32(0);
      const type = type4(head, 4);
      if (boxSize === 1) boxSize = Number(head.getBigUint64(8));
      else if (boxSize === 0) boxSize = size - offset;
      if (boxSize < 8) return null;
      if (type === 'moov') {
        if (boxSize > 200 * 1024 * 1024) return null;
        const buf = await file.slice(offset, offset + boxSize).arrayBuffer();
        return fpsFromMoov(buf);
      }
      offset += boxSize;
    }
  } catch {
    /* 읽기 실패 → null */
  }
  return null;
}
