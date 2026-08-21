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
    mesh.scale.setScalar(m.transform.scale);
    mesh.name = m.name;
    scene.add(mesh);
  }
  return scene;
}

export async function exportGLB(doc: Document): Promise<Blob> {
  const scene = buildExportScene(doc);
  const result = await new GLTFExporter().parseAsync(scene, { binary: true });
  return new Blob([result as ArrayBuffer], { type: 'model/gltf-binary' });
}

export function exportSTL(doc: Document): Blob {
  const scene = buildExportScene(doc);
  scene.updateMatrixWorld(true);
  const data = new STLExporter().parse(scene, { binary: true }) as unknown as DataView;
  return new Blob([data.buffer as ArrayBuffer], { type: 'model/stl' });
}

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 1500);
}
