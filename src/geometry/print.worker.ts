// Thin worker shell around the pure print core (same pattern as split.worker).
import Module from 'manifold-3d';
import { MeshoptSimplifier } from 'meshoptimizer';
import { buildPrintFile, decimateSoup, ManifoldAPI, PrintPart } from './print.js';

// Above this many triangles per part, decimate before sealing: Manifold build
// time and 3MF XML size both scale with tris (a 2M-tri AI scan took ~2 min and
// 21 MB without this; ~25 s and ~4 MB with it). Print accuracy at 500k tris is
// far beyond what an FDM printer can resolve anyway.
const DECIMATE_ABOVE_TRIS = 600_000;
const DECIMATE_TARGET_TRIS = 450_000;

let wasmReady: Promise<ManifoldAPI> | null = null;
function manifoldModule(): Promise<ManifoldAPI> {
  if (!wasmReady) wasmReady = Module().then(w => { w.setup(); return w as unknown as ManifoldAPI; });
  return wasmReady;
}

self.onmessage = async (e: MessageEvent) => {
  const { jobId, parts, provenance } = e.data as { jobId: number; parts: PrintPart[]; provenance: string };
  try {
    const api = await manifoldModule();
    for (const p of parts) {
      if (p.positions.length / 9 > DECIMATE_ABOVE_TRIS) {
        await MeshoptSimplifier.ready;
        p.positions = decimateSoup(MeshoptSimplifier, p.positions, DECIMATE_TARGET_TRIS);
      }
    }
    const res = buildPrintFile(api, parts, provenance ?? '');
    (self as unknown as Worker).postMessage(
      { jobId, ok: true, data: res.data, merged: res.merged, failedNames: res.failedNames, tris: res.tris },
      [res.data.buffer as ArrayBuffer]
    );
  } catch (err) {
    (self as unknown as Worker).postMessage({ jobId, ok: false, error: String((err as Error)?.message ?? err) });
  }
};
