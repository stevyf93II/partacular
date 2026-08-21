// Pure print-path core (worker-independent, node-testable like split.ts).
// Merges triangle soups into a watertight solid via Manifold and packs a 3MF.
import { zipSync, strToU8 } from 'fflate';

export interface PrintPart { name: string; positions: Float32Array }
export interface PrintOutput { data: Uint8Array; merged: number; failedNames: string[]; tris: number }

// Minimal structural types for the manifold-3d module (avoids hard type dep in core).
interface MeshLike {
  merge(): boolean; numProp: number; vertProperties: Float32Array; triVerts: Uint32Array;
}
interface ManifoldLike { getMesh(): MeshLike; delete?(): void }
export interface ManifoldAPI {
  Mesh: new (o: { numProp: number; vertProperties: Float32Array; triVerts: Uint32Array }) => MeshLike;
  Manifold: (new (m: MeshLike) => ManifoldLike) & { union(list: ManifoldLike[]): ManifoldLike };
}

/** Three.js is Y-up; 3MF/printers are Z-up. Proper rotation (x,y,z) -> (x,-z,y). */
export function toZUp(p: Float32Array): Float32Array {
  const out = new Float32Array(p.length);
  for (let i = 0; i < p.length; i += 3) {
    out[i] = p[i]; out[i + 1] = -p[i + 2]; out[i + 2] = p[i + 1];
  }
  return out;
}

const fmt = (n: number) => {
  const r = Math.round(n * 1e5) / 1e5;
  return Object.is(r, -0) ? '0' : String(r);
};

function meshXML(id: number, verts: Float32Array, tris: Uint32Array, name: string): string {
  const v: string[] = [];
  for (let i = 0; i < verts.length; i += 3)
    v.push(`<vertex x="${fmt(verts[i])}" y="${fmt(verts[i + 1])}" z="${fmt(verts[i + 2])}"/>`);
  const t: string[] = [];
  for (let i = 0; i < tris.length; i += 3)
    t.push(`<triangle v1="${tris[i]}" v2="${tris[i + 1]}" v3="${tris[i + 2]}"/>`);
  const safe = name.replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]!));
  return `<object id="${id}" name="${safe}" type="model"><mesh><vertices>${v.join('')}</vertices><triangles>${t.join('')}</triangles></mesh></object>`;
}

function pack3MF(objects: string[], ids: number[]): Uint8Array {
  const model = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
<resources>${objects.join('')}</resources>
<build>${ids.map(i => `<item objectid="${i}"/>`).join('')}</build>
</model>`;
  const types = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>
</Types>`;
  const rels = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
</Relationships>`;
  return zipSync({
    '[Content_Types].xml': strToU8(types),
    '_rels/.rels': strToU8(rels),
    '3D/3dmodel.model': strToU8(model),
  }, { level: 6 });
}

/**
 * parts: de-indexed Y-up triangle soups, transforms already applied.
 * Each part is merged to manifold if possible; manifold parts are unioned into
 * one watertight object. Parts that cannot be sealed ride along as separate
 * objects (slicers usually repair) and are reported in failedNames.
 */
export function buildPrintFile(api: ManifoldAPI, parts: PrintPart[]): PrintOutput {
  const { Manifold, Mesh } = api;
  const solids: ManifoldLike[] = [];
  const failed: PrintPart[] = [];
  for (const p of parts) {
    const positions = toZUp(p.positions);
    const triVerts = new Uint32Array(positions.length / 3);
    for (let i = 0; i < triVerts.length; i++) triVerts[i] = i;
    try {
      const mesh = new Mesh({ numProp: 3, vertProperties: positions, triVerts });
      mesh.merge();
      solids.push(new Manifold(mesh));
    } catch {
      failed.push({ name: p.name, positions });
    }
  }
  if (solids.length === 0 && failed.length === 0) throw new Error('nothing to export');

  const objects: string[] = [];
  const buildIds: number[] = [];
  let nextId = 1;
  let mergedTris = 0;
  if (solids.length > 0) {
    const union = solids.length === 1 ? solids[0] : Manifold.union(solids);
    const out = union.getMesh();
    mergedTris = out.triVerts.length / 3;
    // numProp may exceed 3; positions are always the first three properties.
    const np = out.numProp;
    let verts: Float32Array;
    if (np === 3) verts = out.vertProperties;
    else {
      const nVert = out.vertProperties.length / np;
      verts = new Float32Array(nVert * 3);
      for (let i = 0; i < nVert; i++) {
        verts[i * 3] = out.vertProperties[i * np];
        verts[i * 3 + 1] = out.vertProperties[i * np + 1];
        verts[i * 3 + 2] = out.vertProperties[i * np + 2];
      }
    }
    objects.push(meshXML(nextId, verts, out.triVerts, 'merged'));
    buildIds.push(nextId++);
    union.delete?.();
  }
  for (const f of failed) {
    const triVerts = new Uint32Array(f.positions.length / 3);
    for (let i = 0; i < triVerts.length; i++) triVerts[i] = i;
    objects.push(meshXML(nextId, f.positions, triVerts, `${f.name} (unsealed)`));
    buildIds.push(nextId++);
  }
  return { data: pack3MF(objects, buildIds), merged: solids.length, failedNames: failed.map(f => f.name), tris: mergedTris };
}
