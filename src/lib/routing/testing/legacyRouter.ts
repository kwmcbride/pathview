/**
 * Baseline adapter: the pre-v2 routing pipeline as a pure function
 *
 * Mirrors routingStore.recalculateAllRoutes (sync pass followed by the overlap
 * refinement pass) so tests and benchmarks can measure the baseline without
 * loading the Svelte stores.
 */

import type { Direction, RouteRequest, RouteResult, RoutingScene, Bounds } from '../types';
import { SparseGrid } from '../gridBuilder';
import { calculateRoute, calculateRouteWithWaypoints, getPathCells } from '../routeCalculator';
import { ROUTING_MARGIN, ROUTING_CONTEXT_PADDING } from '../constants';

function canvasBoundsOf(nodeBounds: Map<string, Bounds>): Bounds {
	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;
	for (const b of nodeBounds.values()) {
		minX = Math.min(minX, b.x - ROUTING_MARGIN);
		minY = Math.min(minY, b.y - ROUTING_MARGIN);
		maxX = Math.max(maxX, b.x + b.width + ROUTING_MARGIN);
		maxY = Math.max(maxY, b.y + b.height + ROUTING_MARGIN);
	}
	const p = ROUTING_CONTEXT_PADDING;
	return { x: minX - p, y: minY - p, width: maxX - minX + 2 * p, height: maxY - minY + 2 * p };
}

export function routeSceneLegacy(scene: RoutingScene): Map<string, RouteResult> {
	const nodeBounds = new Map([...scene.nodes].map(([id, node]) => [id, node.bounds]));
	const grid = new SparseGrid({
		nodeBounds,
		canvasBounds: canvasBoundsOf(nodeBounds),
		portStubs: [...scene.nodes.values()].flatMap((node) => node.ports)
	});

	const route = (r: RouteRequest, usedCells?: Map<string, Set<Direction>>): RouteResult =>
		r.waypoints.length > 0
			? calculateRouteWithWaypoints(
					r.source.position,
					r.target.position,
					r.source.direction,
					r.target.direction,
					grid,
					r.waypoints,
					usedCells
				)
			: calculateRoute(r.source.position, r.target.position, r.source.direction, r.target.direction, grid, usedCells);

	const distance = (r: RouteRequest) =>
		Math.abs(r.target.position.x - r.source.position.x) + Math.abs(r.target.position.y - r.source.position.y);
	const sorted = [...scene.requests].sort((a, b) => distance(b) - distance(a));

	const byNet = new Map<string, RouteRequest[]>();
	for (const r of sorted) {
		const group = byNet.get(r.netId) || [];
		group.push(r);
		byNet.set(r.netId, group);
	}

	const routes = new Map<string, RouteResult>();

	// Pass 1: without overlap avoidance
	for (const group of byNet.values()) {
		for (const r of group) routes.set(r.id, route(r));
	}

	// Pass 2: overlap-aware refinement
	const usedCells = new Map<string, Set<Direction>>();
	for (const group of byNet.values()) {
		const groupCells: Map<string, Set<Direction>>[] = [];
		for (const r of group) {
			const result = route(r, usedCells);
			routes.set(r.id, result);
			if (result.path.length > 0) groupCells.push(getPathCells(result.path, 2));
		}
		for (const cells of groupCells) {
			for (const [key, dirs] of cells) {
				if (!usedCells.has(key)) usedCells.set(key, new Set());
				for (const dir of dirs) usedCells.get(key)!.add(dir);
			}
		}
	}

	return routes;
}
