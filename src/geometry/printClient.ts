import * as THREE from 'three';
import { Document } from '../core/document';
import { getGeometry } from './store';

export interface PrintResult { blob: Blob; merged: number; failedNames: string[]; tris: number }

let worker: Worker | null = null;
let jobSeq = 0;
const pending = new Map<number, { resolve: (r: PrintResult) => void; reject: (e: Error) => void }>();

function ensureWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL('./print.worker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = (e: MessageEvent) => {
    const { jobId, ok, data, merged, failedNames, tris, error } = e.data;
    const p = pending.get(jobId); if (!p) return;
    pending.delete(jobId);
    if (ok) p.resolve({ blob: new Blob([data], { type: 'model/3mf' }), merged, failedNames, tris });
    else p.reject(new Error(error));
  };
  worker.onerror = (e: ErrorEvent) => {
    for (const [, p] of pending) p.reject(new Error(e.message || 'print worker crashed'));
    pending.clear();
  };
  return worker;
}

/** De-indexed, world-transformed triangle soup for one part (explode NOT baked in). */
function worldPositions(geo: THREE.BufferGeometry, m: THREE.Matrix4): Float32Array {
  const pos = geo.getAttribute('position') as THREE.BufferAttribute;
  const idx = geo.getIndex();
  const n = idx ? idx.count : pos.count;
  const out = new Float32Array(n * 3);
  const v = new THREE.Vector3();
  for (let i = 0; i < n; i++) {
    v.fromBufferAttribute(pos, idx ? idx.getX(i) : i).applyMatrix4(m);
    out[i * 3] = v.x; out[i * 3 + 1] = v.y; out[i * 3 + 2] = v.z;
  }
  return out;
}

/** Merge all visible parts to a watertight solid and pack as 3MF (runs in a worker). */
export function export3MFInWorker(doc: Document, provenance: string): Promise<PrintResult> {
  const w = ensureWorker();
  const jobId = ++jobSeq;
  const parts: { name: string; positions: Float32Array }[] = [];
  const transfers: ArrayBuffer[] = [];
  const q = new THREE.Quaternion();
  for (const meta of doc.list()) {
    if (!meta.visible) continue;
    const geo = getGeometry(meta.id); if (!geo) continue;
    const t = meta.transform;
    const m = new THREE.Matrix4().compose(
      new THREE.Vector3(...t.position),
      q.fromArray(t.rotation),
      new THREE.Vector3(...t.scale),
    );
    const positions = worldPositions(geo, m);
    parts.push({ name: meta.name, positions });
    transfers.push(positions.buffer as ArrayBuffer);
  }
  if (parts.length === 0) return Promise.reject(new Error('no visible parts'));
  return new Promise((resolve, reject) => {
    pending.set(jobId, { resolve, reject });
    w.postMessage({ jobId, parts, provenance }, transfers);
  });
}
