import * as THREE from 'three';
import type { MergeTree } from './pick.js';
import { chainFor, leavesOf, suggestLevel } from './pick.js';

/** Everything needed to answer "what did they just touch", for one part. */
export interface PickIndex {
  basinOfTri: Int32Array;
  basinCount: number;
  tree: MergeTree;
}

let worker: Worker | null = null;
let jobSeq = 0;
const pending = new Map<number, { resolve: (v: PickIndex) => void; reject: (e: Error) => void }>();

function ensureWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL('./pick.worker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = (e: MessageEvent) => {
    const { jobId, ok, basinOfTri, basinCount, tree, error } = e.data;
    const p = pending.get(jobId);
    if (!p) return;
    pending.delete(jobId);
    if (ok) p.resolve({ basinOfTri, basinCount, tree });
    else p.reject(new Error(error));
  };
  return worker;
}

// One index per part, built on first touch and kept. Rebuilding it costs ~25s
// on a big model, so it must survive selection changes, explode, transforms --
// anything that does not alter the geometry itself.
const cache = new Map<string, PickIndex>();
const inflight = new Map<string, Promise<PickIndex>>();

export function cachedPickIndex(partId: string): PickIndex | undefined {
  return cache.get(partId);
}

export function forgetPickIndex(partId: string) {
  cache.delete(partId);
  inflight.delete(partId);
}

export function clearPickIndexes() {
  cache.clear();
  inflight.clear();
}

/** Build (or reuse) the pick index for a part. Safe to call repeatedly. */
export function pickIndexFor(partId: string, geometry: THREE.BufferGeometry): Promise<PickIndex> {
  const hit = cache.get(partId);
  if (hit) return Promise.resolve(hit);
  const running = inflight.get(partId);
  if (running) return running;

  const posAttr = geometry.getAttribute('position') as THREE.BufferAttribute;
  const positions = new Float32Array(posAttr.array as Float32Array); // copied: the worker takes ownership
  const idx = geometry.getIndex();
  const index = idx ? new Uint32Array(idx.array as ArrayLike<number>) : null;

  const w = ensureWorker();
  const jobId = ++jobSeq;
  const job = new Promise<PickIndex>((resolve, reject) => {
    pending.set(jobId, { resolve, reject });
    const transfers: ArrayBuffer[] = [positions.buffer as ArrayBuffer];
    if (index) transfers.push(index.buffer as ArrayBuffer);
    w.postMessage({ jobId, positions, index }, transfers);
  }).then(res => {
    cache.set(partId, res);
    inflight.delete(partId);
    return res;
  }).catch(err => {
    inflight.delete(partId);
    throw err;
  });

  inflight.set(partId, job);
  return job;
}

export interface Touched {
  /** basin under the finger */
  basin: number;
  /** nested regions from that basin outward; index into this is the drag level */
  levels: number[];
  /** where a touch should land before anyone drags */
  level: number;
}

/** Resolve a raycast hit into a touch, with its ladder of nested regions. */
export function touchAt(index: PickIndex, triangleIndex: number): Touched | null {
  const basin = index.basinOfTri[triangleIndex];
  if (basin < 0) return null;
  return {
    basin,
    levels: chainFor(index.tree, basin),
    level: suggestLevel(index.tree, basin),
  };
}

/** Triangle mask for a touch at a given level. */
export function maskFor(index: PickIndex, touch: Touched, level: number): Uint8Array {
  const clamped = Math.max(0, Math.min(touch.levels.length - 1, level));
  const inRegion = new Uint8Array(index.basinCount);
  for (const b of leavesOf(index.tree, touch.levels[clamped])) inRegion[b] = 1;
  const mask = new Uint8Array(index.basinOfTri.length);
  for (let t = 0; t < mask.length; t++) {
    const b = index.basinOfTri[t];
    if (b >= 0 && inRegion[b]) mask[t] = 1;
  }
  return mask;
}
