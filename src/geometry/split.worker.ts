import { splitConnectedComponents, capGroups } from './split';

const MAX_PARTS = 100;

self.onmessage = (e: MessageEvent) => {
  const { positions, index, jobId } = e.data as { positions: Float32Array; index: Uint32Array | null; jobId: number };
  try {
    let res = splitConnectedComponents({ positions, index });
    res = capGroups(res, MAX_PARTS);
    (self as unknown as Worker).postMessage(
      { jobId, ok: true, triGroup: res.triGroup, groupCount: res.groupCount, groupTriCounts: res.groupTriCounts },
      [res.triGroup.buffer as ArrayBuffer]
    );
  } catch (err) {
    (self as unknown as Worker).postMessage({ jobId, ok: false, error: String(err) });
  }
};
