/**
 * Routing invariants and quality metrics
 *
 * Invariants must hold for every route. Metrics compare router quality
 * (length, bends, overlap between different nets) across implementations.
 */

import type { Position } from '$lib/types/common';
import type { Bounds, PortInfo, RouteResult, RoutingScene } from '../types';
import { DIRECTION_VECTORS } from '../types';
import { GRID_SIZE, SOURCE_CLEARANCE, TARGET_CLEARANCE } from '../constants';
import { snapToGrid } from '../pathOptimizer';

export type ViolationKind =
	| 'missing'
	| 'fallback'
	| 'not-orthogonal'
	| 'off-grid'
	| 'wrong-start'
	| 'wrong-end'
	| 'crosses-node';

export interface Violation {
	connectionId: string;
	kind: ViolationKind;
	detail?: string;
}

export interface RouteMetrics {
	routes: number;
	fallbacks: number;
	totalLength: number;
	bends: number;
	/** Length of grid edges used by more than one net */
	overlapLength: number;
}

function stubEnd(port: PortInfo, clearance: number): Position {
	const vec = DIRECTION_VECTORS[port.direction];
	return snapToGrid({
		x: port.position.x + vec.x * clearance,
		y: port.position.y + vec.y * clearance
	});
}

function onGrid(value: number): boolean {
	return Math.abs(value % GRID_SIZE) < 1e-9;
}

function samePoint(a: Position, b: Position): boolean {
	return a.x === b.x && a.y === b.y;
}

/** Strict interior intersection of an axis-aligned segment with a rectangle */
function segmentCrossesBounds(a: Position, b: Position, r: Bounds): boolean {
	const minX = Math.min(a.x, b.x);
	const maxX = Math.max(a.x, b.x);
	const minY = Math.min(a.y, b.y);
	const maxY = Math.max(a.y, b.y);
	const insideX = minX === maxX ? minX > r.x && minX < r.x + r.width : maxX > r.x && minX < r.x + r.width;
	const insideY = minY === maxY ? minY > r.y && minY < r.y + r.height : maxY > r.y && minY < r.y + r.height;
	return insideX && insideY;
}

/**
 * Check all routes of a scene against the routing invariants.
 * Node crossing is checked naively, intended for small test scenes.
 */
export function checkRoutes(scene: RoutingScene, routes: Map<string, RouteResult>): Violation[] {
	const violations: Violation[] = [];

	for (const request of scene.requests) {
		const id = request.id;
		const route = routes.get(id);
		if (!route || route.path.length === 0) {
			violations.push({ connectionId: id, kind: 'missing' });
			continue;
		}
		if (route.isFallback) violations.push({ connectionId: id, kind: 'fallback' });

		const path = route.path;
		if (!samePoint(path[0], stubEnd(request.source, SOURCE_CLEARANCE))) {
			violations.push({ connectionId: id, kind: 'wrong-start', detail: JSON.stringify(path[0]) });
		}
		if (!samePoint(path[path.length - 1], stubEnd(request.target, TARGET_CLEARANCE))) {
			violations.push({ connectionId: id, kind: 'wrong-end', detail: JSON.stringify(path[path.length - 1]) });
		}

		for (const point of path) {
			if (!onGrid(point.x) || !onGrid(point.y)) {
				violations.push({ connectionId: id, kind: 'off-grid', detail: JSON.stringify(point) });
				break;
			}
		}

		for (let i = 0; i < path.length - 1; i++) {
			const a = path[i];
			const b = path[i + 1];
			if (a.x !== b.x && a.y !== b.y) {
				violations.push({ connectionId: id, kind: 'not-orthogonal', detail: `segment ${i}` });
			}
			for (const [nodeId, node] of scene.nodes) {
				if (segmentCrossesBounds(a, b, node.bounds)) {
					violations.push({ connectionId: id, kind: 'crosses-node', detail: `${nodeId} segment ${i}` });
				}
			}
		}
	}

	return violations;
}

/** Encode a unit grid edge (grid coordinates plus orientation) as a number key */
function encodeEdge(gx: number, gy: number, horizontal: boolean): number {
	return ((gx + 1_000_000) * 2_000_001 + (gy + 1_000_000)) * 2 + (horizontal ? 1 : 0);
}

/**
 * Measure route quality. Overlap counts unit grid edges shared by different nets;
 * connections of the same net (fan-out) may share edges.
 */
export function measureRoutes(scene: RoutingScene, routes: Map<string, RouteResult>): RouteMetrics {
	const metrics: RouteMetrics = { routes: 0, fallbacks: 0, totalLength: 0, bends: 0, overlapLength: 0 };
	const SHARED = '';
	const edgeOwner = new Map<number, string>();

	for (const request of scene.requests) {
		const route = routes.get(request.id);
		if (!route || route.path.length === 0) continue;
		metrics.routes++;
		if (route.isFallback) metrics.fallbacks++;

		const path = route.path;
		metrics.bends += Math.max(0, path.length - 2);

		for (let i = 0; i < path.length - 1; i++) {
			const a = path[i];
			const b = path[i + 1];
			const horizontal = a.y === b.y;
			metrics.totalLength += Math.abs(b.x - a.x) + Math.abs(b.y - a.y);

			const steps = Math.round((horizontal ? Math.abs(b.x - a.x) : Math.abs(b.y - a.y)) / GRID_SIZE);
			const gx0 = Math.round(Math.min(a.x, b.x) / GRID_SIZE);
			const gy0 = Math.round(Math.min(a.y, b.y) / GRID_SIZE);
			for (let s = 0; s < steps; s++) {
				const key = horizontal ? encodeEdge(gx0 + s, gy0, true) : encodeEdge(gx0, gy0 + s, false);
				const owner = edgeOwner.get(key);
				if (owner === undefined) {
					edgeOwner.set(key, request.netId);
				} else if (owner !== SHARED && owner !== request.netId) {
					edgeOwner.set(key, SHARED);
					metrics.overlapLength += GRID_SIZE;
				}
			}
		}
	}

	return metrics;
}
