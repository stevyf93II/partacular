import * as THREE from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { STLExporter } from 'three/examples/jsm/exporters/STLExporter.js';
import { Document } from '../core/document';
import { getGeometry } from './store';

/** Fresh scene from the document (visible parts, transforms applied, explode NOT baked in). */
function buildExportScene(doc: Document): THREE.Scene {
  const scene = new THREE.Scene();
  for (const m of doc.list()) {
    if (!m.visible) continue;
    const geo = getGeometry(m.id); if (!geo) continue;
    const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: m.color }));
    mesh.position.set(...m.transform.position);
    mesh.rotation.set(0, m.transform.rotationY, 0);
    mesh.scale.set(...m.transform.scale);
    mesh.name = m.name;
    scene.add(mesh);
  }
  return scene;
}

export async function exportGLB(doc: Document, provenance: string): Promise<Blob> {
  const scene = buildExportScene(doc);
  // self-describing artifact: effective config rides along as glTF extras
  scene.userData = { partacular: provenance };
  const result = await new GLTFExporter().parseAsync(scene, { binary: true });
  return new Blob([result as ArrayBuffer], { type: 'model/gltf-binary' });
}

export function exportSTL(doc: Document, provenance: string): Blob {
  const scene = buildExportScene(doc);
  scene.updateMatrixWorld(true);
  const data = new STLExporter().parse(scene, { binary: true }) as unknown as DataView;
  // self-describing artifact: binary STL's 80-byte header carries the config
  const bytes = new Uint8Array(data.buffer as ArrayBuffer);
  const header = new TextEncoder().encode(provenance.slice(0, 80));
  bytes.set(header.subarray(0, 80), 0);
  return new Blob([bytes.buffer], { type: 'model/stl' });
}

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 1500);
}
