import type * as THREE from 'three';

// Geometry lives OUTSIDE the core document (core stays plain data).
const geometries = new Map<string, THREE.BufferGeometry>();

export function putGeometry(id: string, g: THREE.BufferGeometry) { geometries.set(id, g); }
export function getGeometry(id: string): THREE.BufferGeometry | undefined { return geometries.get(id); }
export function clearGeometries() { for (const g of geometries.values()) g.dispose(); geometries.clear(); }
