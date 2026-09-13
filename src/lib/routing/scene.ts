/**
 * Scene comparisons - decide whether routing input changed
 */

import type { Waypoint } from '$lib/types/nodes';
import type { PortInfo, RouteRequest, SceneNode } from './types';

function samePort(a: PortInfo, b: PortInfo): boolean {
	return a.direction === b.direction && a.position.x === b.position.x && a.position.y === b.position.y;
}

export function sameWaypoints(a: Waypoint[], b: Waypoint[]): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) {
		if (a[i].position.x !== b[i].position.x || a[i].position.y !== b[i].position.y) return false;
	}
	return true;
}

export function sameRequest(a: RouteRequest | undefined, b: RouteRequest): boolean {
	return (
		a !== undefined &&
		a.netId === b.netId &&
		samePort(a.source, b.source) &&
		samePort(a.target, b.target) &&
		sameWaypoints(a.waypoints, b.waypoints)
	);
}

export function sameSceneNode(a: SceneNode | undefined, b: SceneNode): boolean {
	if (a === undefined || a.ports.length !== b.ports.length) return false;
	const p = a.bounds;
	const q = b.bounds;
	if (p.x !== q.x || p.y !== q.y || p.width !== q.width || p.height !== q.height) return false;
	for (let i = 0; i < a.ports.length; i++) {
		if (!samePort(a.ports[i], b.ports[i])) return false;
	}
	return true;
}
