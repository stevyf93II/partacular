import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';

export interface LoadedPart { name: string; geometry: THREE.BufferGeometry; }

/** Parse a model file into candidate parts.
 *  GLB/GLTF/OBJ: each mesh node = one candidate part (world transform baked in).
 *  STL: one raw geometry, caller sends it to the splitter worker.        */
export async function parseFile(file: File): Promise<{ parts: LoadedPart[]; needsSplit: boolean }> {
  const ext = file.name.split('.').pop()!.toLowerCase();
  const buf = await file.arrayBuffer();
  if (ext === 'glb' || ext === 'gltf') {
    const gltf = await new GLTFLoader().parseAsync(buf, '');
    const parts = collectMeshes(gltf.scene);
    return { parts, needsSplit: parts.length <= 1 };
  }
  if (ext === 'obj') {
    const text = new TextDecoder().decode(buf);
    const group = new OBJLoader().parse(text);
    const parts = collectMeshes(group);
    return { parts, needsSplit: parts.length <= 1 };
  }
  if (ext === 'stl') {
    const geo = new STLLoader().parse(buf);
    geo.deleteAttribute('normal'); // recomputed after split
    return { parts: [{ name: baseName(file.name), geometry: geo }], needsSplit: true };
  }
  throw new Error(`Unsupported file type: .${ext}`);
}

function baseName(n: string) { return n.replace(/\.[^.]+$/, ''); }

function collectMeshes(root: THREE.Object3D): LoadedPart[] {
  root.updateWorldMatrix(true, true);
  const out: LoadedPart[] = [];
  root.traverse(obj => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh || !mesh.geometry) return;
    const geo = mesh.geometry.clone();
    if (geo.index === null && !geo.getAttribute('position')) return;
    geo.applyMatrix4(mesh.matrixWorld);
    // strip attributes we don't use so split/merge stays simple
    for (const name of Object.keys(geo.attributes)) if (name !== 'position' && name !== 'normal' && name !== 'uv') geo.deleteAttribute(name);
    out.push({ name: mesh.name || `part ${out.length + 1}`, geometry: geo });
  });
  return out;
}

/** Build sub-geometries from a splitter result (triangle group labels). */
export function buildGroupGeometries(
  source: THREE.BufferGeometry, triGroup: Uint32Array, groupCount: number
): THREE.BufferGeometry[] {
  const pos = source.getAttribute('position') as THREE.BufferAttribute;
  const index = source.getIndex();
  const triCount = index ? index.count / 3 : pos.count / 3;
  const sizes = new Uint32Array(groupCount);
  for (let t = 0; t < triCount; t++) sizes[triGroup[t]]++;
  const buffers = Array.from(sizes, s => new Float32Array(s * 9));
  const cursors = new Uint32Array(groupCount);
  const vid = (t: number, c: number) => index ? index.getX(t * 3 + c) : t * 3 + c;
  for (let t = 0; t < triCount; t++) {
    const g = triGroup[t]; const buf = buffers[g]; let o = cursors[g] * 9;
    for (let c = 0; c < 3; c++) {
      const v = vid(t, c);
      buf[o++] = pos.getX(v); buf[o++] = pos.getY(v); buf[o++] = pos.getZ(v);
    }
    cursors[g]++;
  }
  return buffers.map(buf => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(buf, 3));
    g.computeVertexNormals();
    return g;
  });
}

/** Demo model: several primitives welded into ONE triangle soup, so the split path gets exercised for real. */
export function demoSoup(): THREE.BufferGeometry {
  const geos: THREE.BufferGeometry[] = [];
  const add = (g: THREE.BufferGeometry, x: number, y: number, z: number) => {
    g.translate(x, y, z); geos.push(g.toNonIndexed());
  };
  add(new THREE.BoxGeometry(2, 0.4, 2), 0, -0.2, 0);                      // base plate
  add(new THREE.CylinderGeometry(0.35, 0.35, 1.2, 24), -0.55, 0.6, -0.4); // post 1
  add(new THREE.CylinderGeometry(0.35, 0.35, 1.2, 24), 0.55, 0.6, -0.4);  // post 2
  add(new THREE.SphereGeometry(0.42, 24, 16), 0, 0.75, 0.45);             // knob
  add(new THREE.TorusGeometry(0.5, 0.14, 14, 40), 0, 1.55, -0.4);         // handle
  add(new THREE.ConeGeometry(0.3, 0.8, 20), 0, 1.75, 0.45);               // spike
  const total = geos.reduce((s, g) => s + g.getAttribute('position').count, 0);
  const buf = new Float32Array(total * 3);
  let off = 0;
  for (const g of geos) {
    const p = g.getAttribute('position') as THREE.BufferAttribute;
    buf.set(p.array as Float32Array, off); off += p.count * 3;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(buf, 3));
  return out;
}
