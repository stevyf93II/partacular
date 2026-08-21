// Thin worker shell around the pure print core (same pattern as split.worker).
import Module from 'manifold-3d';
import { buildPrintFile, ManifoldAPI, PrintPart } from './print';

let wasmReady: Promise<ManifoldAPI> | null = null;
function manifoldModule(): Promise<ManifoldAPI> {
  if (!wasmReady) wasmReady = Module().then(w => { w.setup(); return w as unknown as ManifoldAPI; });
  return wasmReady;
}

self.onmessage = async (e: MessageEvent) => {
  const { jobId, parts } = e.data as { jobId: number; parts: PrintPart[] };
  try {
    const api = await manifoldModule();
    const res = buildPrintFile(api, parts);
    (self as unknown as Worker).postMessage(
      { jobId, ok: true, data: res.data, merged: res.merged, failedNames: res.failedNames, tris: res.tris },
      [res.data.buffer as ArrayBuffer]
    );
  } catch (err) {
    (self as unknown as Worker).postMessage({ jobId, ok: false, error: String((err as Error)?.message ?? err) });
  }
};
