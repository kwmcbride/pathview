/**
 * Orthogonal A* on the obstacle grid
 *
 * Turn penalty, no reversals, weighted start directions and optional arrival
 * direction. States (cell, direction) are packed into integers inside a
 * bounded search window and all bookkeeping uses reused typed arrays, so a
 * search allocates nothing but its result.
 */

import { HARD_MASK, type ObstacleMap } from './obstacleMap';
import { DX, DY, OPPOSITE, type GridPoint, type GridRect } from './gridTypes';

/** Cost of a 90 degree turn in grid steps */
export const TURN_COST = 2;

/** Extra cost per step through a soft obstacle (node margin, cell in front of a port) */
export const SOFT_COST = 6;

/** Window paddings (cells around start and end) tried before the full extent */
const WINDOW_PADDINGS = [16, 64];

/** Upper bound for states of one search (caps memory at about 50 MB) */
const MAX_STATES = 4_000_000;

/** Upper bound for expanded states of one search window (caps time for unreachable ends) */
const MAX_EXPANSIONS = 250_000;

/** Cost above the cheapest arrival up to which arrivals from other directions are still collected */
const ARRIVAL_SLACK = 2 * TURN_COST + 2;

/** Counters for benchmarks and profiling */
export const searchStats = { searches: 0, expanded: 0 };

/** Extra step costs from other routes (negotiated congestion) */
export interface CongestionCosts {
	penalty(gx: number, gy: number, axis: 0 | 1): number;
}

/** A start direction with the cost already spent to get there */
export interface SearchStart {
	dir: number;
	cost: number;
}

export interface GridSearch {
	/** Optional congestion costs added per step */
	congestion?: CongestionCosts;
	/** Heuristic weight; above 1 trades bounded path cost for fewer expanded states (default 1) */
	heuristicWeight?: number;
	start: GridPoint;
	/** Start directions; the first step follows the start direction */
	starts: SearchStart[];
	end: GridPoint;
	/** Required arrival direction (turn penalty otherwise), or -1 for any */
	endDir: number;
	/** Cells walkable regardless of obstacles (port exits and entries) */
	forced: GridPoint[];
}

export interface GridPath {
	/** Corner cells from start to end, both included */
	corners: GridPoint[];
	startDir: number;
	arrivalDir: number;
	/** Total cost including the start cost */
	cost: number;
}

// Reused buffers, grown on demand
let capacity = 0;
let gScore = new Int32Array(0);
let parent = new Int32Array(0);
/** (generation << 1) | closed */
let stamp = new Uint32Array(0);
let generation = 0;
let heapState = new Int32Array(1024);
let heapKey = new Float64Array(1024);
let heapSize = 0;

function ensureCapacity(states: number): void {
	if (states <= capacity) return;
	capacity = Math.max(states, Math.min(capacity * 2, MAX_STATES));
	gScore = new Int32Array(capacity);
	parent = new Int32Array(capacity);
	stamp = new Uint32Array(capacity);
	generation = 0;
}

function heapPush(state: number, key: number): void {
	if (heapSize === heapState.length) {
		const states = new Int32Array(heapSize * 2);
		const keys = new Float64Array(heapSize * 2);
		states.set(heapState);
		keys.set(heapKey);
		heapState = states;
		heapKey = keys;
	}
	let i = heapSize++;
	while (i > 0) {
		const p = (i - 1) >> 1;
		if (heapKey[p] <= key) break;
		heapState[i] = heapState[p];
		heapKey[i] = heapKey[p];
		i = p;
	}
	heapState[i] = state;
	heapKey[i] = key;
}

function heapPop(): number {
	const top = heapState[0];
	heapSize--;
	const lastState = heapState[heapSize];
	const lastKey = heapKey[heapSize];
	let i = 0;
	while (true) {
		let c = 2 * i + 1;
		if (c >= heapSize) break;
		if (c + 1 < heapSize && heapKey[c + 1] < heapKey[c]) c++;
		if (heapKey[c] >= lastKey) break;
		heapState[i] = heapState[c];
		heapKey[i] = heapKey[c];
		i = c;
	}
	heapState[i] = lastState;
	heapKey[i] = lastKey;
	return top;
}

/** Minimum number of turns to reach an offset (dx, dy) moving in direction d, ignoring obstacles */
function minTurns(dx: number, dy: number, d: number): number {
	const ahead = d === 0 ? dx : d === 1 ? -dx : d === 2 ? dy : -dy;
	const side = d <= 1 ? dy : dx;
	if (side === 0) return ahead >= 0 ? 0 : 2;
	return ahead >= 0 ? 1 : 2;
}

/** Admissible remaining cost estimate */
function heuristic(gx: number, gy: number, d: number, end: GridPoint): number {
	const dx = end.gx - gx;
	const dy = end.gy - gy;
	return Math.abs(dx) + Math.abs(dy) + TURN_COST * minTurns(dx, dy, d);
}

function windowAround(request: GridSearch, padding: number): GridRect {
	const { start, end } = request;
	return {
		minGx: Math.min(start.gx, end.gx) - padding,
		minGy: Math.min(start.gy, end.gy) - padding,
		maxGx: Math.max(start.gx, end.gx) + padding,
		maxGy: Math.max(start.gy, end.gy) + padding
	};
}

/** Search in widening windows; arrivals are indexed by arrival direction */
function searchWindows(map: ObstacleMap, request: GridSearch, collect: boolean): (GridPath | undefined)[] | null {
	for (const padding of WINDOW_PADDINGS) {
		const found = searchWindow(map, request, windowAround(request, padding), collect);
		if (found) return found;
	}
	const near = windowAround(request, WINDOW_PADDINGS[0]);
	const e = map.extent;
	return searchWindow(
		map,
		request,
		{
			minGx: Math.min(near.minGx, e.minGx - WINDOW_PADDINGS[0]),
			minGy: Math.min(near.minGy, e.minGy - WINDOW_PADDINGS[0]),
			maxGx: Math.max(near.maxGx, e.maxGx + WINDOW_PADDINGS[0]),
			maxGy: Math.max(near.maxGy, e.maxGy + WINDOW_PADDINGS[0])
		},
		collect
	);
}

/**
 * Find the cheapest orthogonal path, widening the search window when needed.
 * Returns null if the end is unreachable.
 */
export function searchGridPath(map: ObstacleMap, request: GridSearch): GridPath | null {
	return searchWindows(map, request, false)?.find((path) => path !== undefined) ?? null;
}

/**
 * Find the cheapest path to the end for each arrival direction that is not far
 * more expensive than the cheapest one. Used for waypoints, where the best way
 * to arrive depends on how the route continues.
 */
export function searchGridArrivals(map: ObstacleMap, request: GridSearch): (GridPath | undefined)[] {
	return searchWindows(map, request, true) ?? [];
}

function searchWindow(
	map: ObstacleMap,
	request: GridSearch,
	win: GridRect,
	collect: boolean
): (GridPath | undefined)[] | null {
	const w = win.maxGx - win.minGx + 1;
	const h = win.maxGy - win.minGy + 1;
	const states = w * h * 4;
	if (states > MAX_STATES) return null;
	ensureCapacity(states);
	searchStats.searches++;

	generation++;
	if (generation >= 0x7fffffff) {
		stamp.fill(0);
		generation = 1;
	}
	const seen = generation << 1;
	const closed = seen | 1;
	heapSize = 0;

	const { start, end, endDir, forced, congestion } = request;
	const weight = request.heuristicWeight ?? 1;
	const x0 = win.minGx;
	const y0 = win.minGy;

	const isForced = (gx: number, gy: number): boolean => {
		for (let i = 0; i < forced.length; i++) {
			if (forced[i].gx === gx && forced[i].gy === gy) return true;
		}
		return false;
	};

	const startCell = (start.gy - y0) * w + (start.gx - x0);
	for (const s of request.starts) {
		const state = startCell * 4 + s.dir;
		if (stamp[state] === seen && gScore[state] <= s.cost) continue;
		gScore[state] = s.cost;
		parent[state] = -1;
		stamp[state] = seen;
		const hh = heuristic(start.gx, start.gy, s.dir, end);
		heapPush(state, (s.cost + weight * hh) * 65536 + hh);
	}

	const arrivals: (GridPath | undefined)[] = [];
	let arrivalCount = 0;
	let bestArrival = Infinity;
	let expanded = 0;

	while (heapSize > 0) {
		if (arrivalCount > 0 && heapKey[0] / 65536 > bestArrival + ARRIVAL_SLACK) break;
		const s = heapPop();
		if (stamp[s] === closed) continue;
		stamp[s] = closed;
		searchStats.expanded++;
		if (++expanded > MAX_EXPANSIONS) break;

		const d = s & 3;
		const cell = s >> 2;
		const gx = (cell % w) + x0;
		const gy = ((cell / w) | 0) + y0;

		if (gx === end.gx && gy === end.gy) {
			const path = reconstruct(s, w, x0, y0);
			if (!collect) return [path];
			if (arrivals[d] === undefined) {
				arrivals[d] = path;
				arrivalCount++;
				bestArrival = Math.min(bestArrival, path.cost);
				if (arrivalCount === 4) break;
			}
		}

		const g = gScore[s];
		const isStart = parent[s] === -1;

		for (let nd = 0; nd < 4; nd++) {
			if (nd === OPPOSITE[d]) continue;
			if (isStart && nd !== d) continue;

			const nx = gx + DX[nd];
			const ny = gy + DY[nd];
			if (nx < win.minGx || nx > win.maxGx || ny < win.minGy || ny > win.maxGy) continue;

			let value = map.cell(nx, ny);
			if (value !== 0 && isForced(nx, ny)) value = 0;
			if (value & HARD_MASK) continue;

			let cost = g + 1 + (nd === d ? 0 : TURN_COST) + (value === 0 ? 0 : SOFT_COST);
			if (congestion !== undefined) cost += congestion.penalty(nx, ny, nd <= 1 ? 0 : 1);
			if (endDir >= 0 && nd !== endDir && nx === end.gx && ny === end.gy) cost += TURN_COST;

			const ns = ((ny - y0) * w + (nx - x0)) * 4 + nd;
			const st = stamp[ns];
			if (st === closed) continue;
			if (st === seen && gScore[ns] <= cost) continue;

			gScore[ns] = cost;
			parent[ns] = s;
			stamp[ns] = seen;

			const hh = heuristic(nx, ny, nd, end);
			heapPush(ns, (cost + weight * hh) * 65536 + hh);
		}
	}

	return arrivalCount > 0 ? arrivals : null;
}

function reconstruct(goal: number, w: number, x0: number, y0: number): GridPath {
	const corners: GridPoint[] = [];
	let s = goal;
	let nextDir = -1;
	let startDir = goal & 3;
	while (s !== -1) {
		const d = s & 3;
		const p = parent[s];
		if (nextDir === -1 || p === -1 || nextDir !== d) {
			const cell = s >> 2;
			corners.push({ gx: (cell % w) + x0, gy: ((cell / w) | 0) + y0 });
		}
		if (p === -1) startDir = d;
		nextDir = d;
		s = p;
	}
	corners.reverse();
	return { corners, startDir, arrivalDir: goal & 3, cost: gScore[goal] };
}
