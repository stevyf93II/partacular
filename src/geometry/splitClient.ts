import * as THREE from 'three';

export interface SplitOutcome {
  triGroup: Uint32Array;
  groupCount: number;
  groupTriCounts: Uint32Array;
  /** group holding everything too small to be a part, or -1 */
  debrisGroup: number;
  debrisPieces: number;
}

let worker: Worker | null = null;
let jobSeq = 0;
const pending = new Map<number, { resolve: (r: SplitOutcome) => void; reject: (e: Error) => void }>();

function ensureWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL('./split.worker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = (e: MessageEvent) => {
    const { jobId, ok, triGroup, groupCount, groupTriCounts, debrisGroup, debrisPieces, error } = e.data;
    const p = pending.get(jobId); if (!p) return;
    pending.delete(jobId);
    if (ok) p.resolve({ triGroup, groupCount, groupTriCounts, debrisGroup: debrisGroup ?? -1, debrisPieces: debrisPieces ?? 0 });
    else p.reject(new Error(error));
  };
  return worker;
}

/** Ships position/index buffers to the worker; original geometry is untouched (buffers are copied). */
export function splitInWorker(geometry: THREE.BufferGeometry): Promise<SplitOutcome> {
  const w = ensureWorker();
  const jobId = ++jobSeq;
  const posAttr = geometry.getAttribute('position') as THREE.BufferAttribute;
  const positions = new Float32Array(posAttr.array as Float32Array); // copy
  const idx = geometry.getIndex();
  const index = idx ? new Uint32Array(idx.array as ArrayLike<number>) : null;
  return new Promise((resolve, reject) => {
    pending.set(jobId, { resolve, reject });
    const transfers: ArrayBuffer[] = [positions.buffer as ArrayBuffer];
    if (index) transfers.push(index.buffer as ArrayBuffer);
    w.postMessage({ jobId, positions, index }, transfers);
  });
}
