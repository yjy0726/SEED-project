/**
 * 아주 작은 MP4/MOV 분해기: 영상 트랙의 프레임(샘플) 위치·시간과 코덱 정보를 읽는다.
 * WebCodecs VideoDecoder 로 영상을 재생 없이 빠르게 풀 때 사용한다.
 */

export interface DemuxSample {
  offset: number;
  size: number;
  /** 표시 시각 (s), 첫 프레임 = 0 */
  time: number;
  /** 표시 시각 (마이크로초, 정수) */
  timestampUs: number;
  key: boolean;
}

export interface DemuxTrack {
  /** WebCodecs 코덱 문자열 (예: avc1.64001f) */
  codec: string;
  /** avcC / hvcC / vpcC / av1C 상자 내용 */
  description?: Uint8Array;
  codedWidth: number;
  codedHeight: number;
  /** tkhd 회전 (0, 90, 180, 270 — 시계 방향) */
  rotation: number;
  timescale: number;
  samples: DemuxSample[];
}

const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'edts']);

function type4(v: DataView, o: number): string {
  return String.fromCharCode(v.getUint8(o), v.getUint8(o + 1), v.getUint8(o + 2), v.getUint8(o + 3));
}

function children(v: DataView, start: number, end: number, cb: (type: string, body: number, end: number) => void) {
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

const hex2 = (n: number) => n.toString(16).padStart(2, '0');

function avcCodec(d: Uint8Array): string {
  return `avc1.${hex2(d[1])}${hex2(d[2])}${hex2(d[3])}`;
}

function hevcCodec(prefix: string, d: Uint8Array): string {
  const profileSpace = d[1] >> 6;
  const tier = (d[1] >> 5) & 1;
  const profile = d[1] & 0x1f;
  let compat = ((d[2] << 24) | (d[3] << 16) | (d[4] << 8) | d[5]) >>> 0;
  // 호환 플래그는 비트 순서를 뒤집어 16진수로
  let rev = 0;
  for (let i = 0; i < 32; i++) {
    rev = (rev << 1) | (compat & 1);
    compat >>>= 1;
  }
  const level = d[12];
  const cons: string[] = [];
  for (let i = 6; i < 12; i++) cons.push(d[i].toString(16).toUpperCase());
  while (cons.length > 1 && cons[cons.length - 1] === '0') cons.pop();
  const space = ['', 'A', 'B', 'C'][profileSpace];
  return `${prefix}.${space}${profile}.${(rev >>> 0).toString(16).toUpperCase()}.${tier ? 'H' : 'L'}${level}.${cons.join('.')}`;
}

function vp9Codec(d: Uint8Array): string {
  // vpcC: version(1) flags(3) profile(1) level(1) bitDepth(4bit)...
  const profile = d[4];
  const level = d[5];
  const bitDepth = d[6] >> 4;
  return `vp09.${String(profile).padStart(2, '0')}.${String(level).padStart(2, '0')}.${String(bitDepth).padStart(2, '0')}`;
}

function av1Codec(d: Uint8Array): string {
  const profile = d[1] >> 5;
  const level = d[1] & 0x1f;
  const tier = d[2] >> 7 ? 'H' : 'M';
  const highBit = (d[2] >> 6) & 1;
  const twelve = (d[2] >> 5) & 1;
  const bitDepth = profile === 2 && highBit ? (twelve ? 12 : 10) : highBit ? 10 : 8;
  return `av01.${profile}.${String(level).padStart(2, '0')}${tier}.${String(bitDepth).padStart(2, '0')}`;
}

interface Raw {
  isVideo: boolean;
  timescale: number;
  rotation: number;
  entry?: { codec: string; description?: Uint8Array; w: number; h: number };
  stts: [number, number][];
  ctts: [number, number][];
  stsz: number[];
  stsc: [number, number][]; // [firstChunk, samplesPerChunk]
  chunks: number[];
  stss: Set<number> | null;
}

/** moov 상자(또는 moov 를 포함한 버퍼)에서 첫 영상 트랙을 읽는다. 지원 안 되면 null */
export function demuxMoov(buf: ArrayBuffer): DemuxTrack | null {
  const v = new DataView(buf);
  const u8 = new Uint8Array(buf);
  const tracks: Raw[] = [];
  let cur: Raw | null = null;

  const visit = (type: string, body: number, end: number) => {
    if (type === 'trak') {
      cur = { isVideo: false, timescale: 0, rotation: 0, stts: [], ctts: [], stsz: [], stsc: [], chunks: [], stss: null };
      tracks.push(cur);
    }
    if (CONTAINERS.has(type)) return children(v, body, end, visit);
    const t = cur as Raw | null;
    if (!t) return;
    switch (type) {
      case 'tkhd': {
        const ver = v.getUint8(body);
        const m = body + (ver === 1 ? 52 : 40);
        if (m + 20 > end) break;
        const a = v.getInt32(m) / 65536;
        const b = v.getInt32(m + 4) / 65536;
        const deg = Math.round((Math.atan2(b, a) * 180) / Math.PI);
        t.rotation = ((deg % 360) + 360) % 360;
        break;
      }
      case 'hdlr':
        t.isVideo = t.isVideo || type4(v, body + 8) === 'vide';
        break;
      case 'mdhd': {
        const ver = v.getUint8(body);
        t.timescale = v.getUint32(body + (ver === 1 ? 20 : 12));
        break;
      }
      case 'stsd': {
        const entry = body + 8; // version/flags + entry_count
        if (entry + 8 > end) break;
        const esize = v.getUint32(entry);
        const fmt = type4(v, entry + 4);
        const w = v.getUint16(entry + 32);
        const h = v.getUint16(entry + 34);
        let codec = '';
        let description: Uint8Array | undefined;
        // VisualSampleEntry 머리말 = 8 + 78 바이트, 그 뒤에 설정 상자들
        children(v, entry + 86, Math.min(end, entry + esize), (ct, cb, ce) => {
          const d = u8.slice(cb, ce);
          if (ct === 'avcC') {
            codec = avcCodec(d);
            description = d;
          } else if (ct === 'hvcC') {
            codec = hevcCodec(fmt === 'hev1' ? 'hev1' : 'hvc1', d);
            description = d;
          } else if (ct === 'vpcC') codec = vp9Codec(d);
          else if (ct === 'av1C') codec = av1Codec(d);
        });
        if (codec) t.entry = { codec, description, w, h };
        break;
      }
      case 'stts':
      case 'ctts': {
        const n = v.getUint32(body + 4);
        const arr = type === 'stts' ? t.stts : t.ctts;
        const ver = v.getUint8(body);
        for (let i = 0; i < n && body + 16 + i * 8 <= end; i++) {
          const o = body + 8 + i * 8;
          const off = type === 'ctts' && ver === 1 ? v.getInt32(o + 4) : v.getUint32(o + 4);
          arr.push([v.getUint32(o), off]);
        }
        break;
      }
      case 'stsz': {
        const fixed = v.getUint32(body + 4);
        const n = v.getUint32(body + 8);
        for (let i = 0; i < n; i++) t.stsz.push(fixed || v.getUint32(body + 12 + i * 4));
        break;
      }
      case 'stsc': {
        const n = v.getUint32(body + 4);
        for (let i = 0; i < n; i++) t.stsc.push([v.getUint32(body + 8 + i * 12), v.getUint32(body + 12 + i * 12)]);
        break;
      }
      case 'stco':
      case 'co64': {
        const n = v.getUint32(body + 4);
        for (let i = 0; i < n; i++)
          t.chunks.push(type === 'stco' ? v.getUint32(body + 8 + i * 4) : Number(v.getBigUint64(body + 8 + i * 8)));
        break;
      }
      case 'stss': {
        const n = v.getUint32(body + 4);
        t.stss = new Set();
        for (let i = 0; i < n; i++) t.stss.add(v.getUint32(body + 8 + i * 4));
        break;
      }
    }
  };
  children(v, 0, buf.byteLength, visit);

  const t = tracks.find((r) => r.isVideo && r.entry && r.timescale > 0 && r.stsz.length > 0);
  if (!t || !t.entry) return null;

  // 샘플별 파일 위치
  const n = t.stsz.length;
  const offsets: number[] = new Array(n);
  let s = 0;
  for (let ci = 0; ci < t.chunks.length && s < n; ci++) {
    const chunkNo = ci + 1;
    let per = 0;
    for (const [first, spc] of t.stsc) if (first <= chunkNo) per = spc;
    let off = t.chunks[ci];
    for (let k = 0; k < per && s < n; k++, s++) {
      offsets[s] = off;
      off += t.stsz[s];
    }
  }
  if (s < n) return null;

  // 샘플별 시간
  const dts: number[] = [];
  let acc = 0;
  for (const [count, delta] of t.stts) for (let k = 0; k < count && dts.length < n; k++, acc += delta) dts.push(acc);
  while (dts.length < n) dts.push(acc);
  const cts = dts.slice();
  let idx = 0;
  for (const [count, off] of t.ctts) for (let k = 0; k < count && idx < n; k++, idx++) cts[idx] += off;
  const minCts = Math.min(...cts);

  const samples: DemuxSample[] = [];
  for (let i = 0; i < n; i++) {
    const time = (cts[i] - minCts) / t.timescale;
    samples.push({
      offset: offsets[i],
      size: t.stsz[i],
      time,
      timestampUs: Math.round(time * 1e6),
      key: t.stss ? t.stss.has(i + 1) : true,
    });
  }
  return {
    codec: t.entry.codec,
    description: t.entry.description,
    codedWidth: t.entry.w,
    codedHeight: t.entry.h,
    rotation: t.rotation,
    timescale: t.timescale,
    samples,
  };
}

/** 파일에서 moov 를 찾아 분해. 실패하면 null */
export async function demuxFile(file: Blob): Promise<DemuxTrack | null> {
  try {
    let offset = 0;
    for (let guard = 0; guard < 1000 && offset + 8 <= file.size; guard++) {
      const head = new DataView(await file.slice(offset, offset + 16).arrayBuffer());
      let size = head.getUint32(0);
      const type = type4(head, 4);
      if (size === 1) size = Number(head.getBigUint64(8));
      else if (size === 0) size = file.size - offset;
      if (size < 8) return null;
      if (type === 'moov') {
        if (size > 200 * 1024 * 1024) return null;
        return demuxMoov(await file.slice(offset, offset + size).arrayBuffer());
      }
      offset += size;
    }
  } catch {
    /* 실패 → null */
  }
  return null;
}
