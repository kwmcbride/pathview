/**
 * Routing engine - incremental orthogonal routing on the canvas grid
 *
 * Framework free so it can run in a worker. Connections are searched with
 * congestion costs from the other nets (negotiated congestion routing), a
 * negotiation loop re-searches nets that still share grid lines, and a final
 * nudging pass separates the remaining overlaps into lanes. After changes only
 * affected nets are searched again.
 */

import type { Bounds, PortInfo, PortStub, RouteRequest, RouteResult, RoutingScene } from './types';
import { ObstacleMap } from './obstacleMap';
import { Occupancy, collectCells } from './occupancy';
import { searchGridPath } from './search';
import { nudgeRoutes, simplifyGridPath, type NudgeRoute } from './nudge';
import {
	DIRECTION_INDEX,
	DX,
	DY,
	OPPOSITE,
	toGrid,
	fromGrid,
	type GridPoint,
	type GridRect
} from './gridTypes';
import { GRID_SIZE, ROUTING_MARGIN, SOURCE_CLEARANCE, TARGET_CLEARANCE } from './constants';

/** Cells walkable in front of a port so routes can pass the node margin */
const PORT_EXIT_CELLS = 3;

/** Cells around a changed node within which existing routes are searched again */
const REROUTE_PADDING = 2;

/** Tile size (cells) of the spatial index over routes */
const INDEX_TILE = 16;

/** Congestion cost per other net on a cell in the first search */
const PRESENT_COST = 2;

/** History cost added to contested cells after each negotiation iteration */
const HISTORY_COST = 1;

/** Negotiation continues only while contested cells drop below this share of the previous iteration */
const NEGOTIATION_PROGRESS = 0.8;

export interface RoutingEngineOptions {
	/** Search with congestion costs from other nets (default true) */
	congestion?: boolean;
	/** Separate remaining overlaps into lanes (default true) */
	nudge?: boolean;
}

export interface UpdateOptions {
	/** Negotiation iterations re-searching nets that still overlap (default 0) */
	negotiate?: number;
}

export interface RoutingUpdate {
	/** New or changed routes */
	changed: Map<string, RouteResult>;
	/** Connections whose routes were removed */
	removed: string[];
}

interface NodeEntry {
	/** Node interior, impassable */
	body: GridRect;
	/** Node including its margin, passable at extra cost */
	rect: GridRect;
	stubs: GridPoint[];
}

interface RawRoute {
	corners: GridPoint[];
	isFallback: boolean;
	tiles: number[];
}

function bodyRect(bounds: Bounds): GridRect {
	return {
		minGx: toGrid(bounds.x),
		minGy: toGrid(bounds.y),
		maxGx: toGrid(bounds.x + bounds.width),
		maxGy: toGrid(bounds.y + bounds.height)
	};
}

function marginRect(bounds: Bounds): GridRect {
	return {
		minGx: toGrid(bounds.x - ROUTING_MARGIN),
		minGy: toGrid(bounds.y - ROUTING_MARGIN),
		maxGx: toGrid(bounds.x + bounds.width + ROUTING_MARGIN),
		maxGy: toGrid(bounds.y + bounds.height + ROUTING_MARGIN)
	};
}

/** Cell directly in front of a port, kept free of other routes */
function stubCell(port: PortStub): GridPoint {
	const d = DIRECTION_INDEX[port.direction];
	return {
		gx: toGrid(port.position.x + DX[d] * GRID_SIZE),
		gy: toGrid(port.position.y + DY[d] * GRID_SIZE)
	};
}

/** Route end cell of a port at the given clearance */
function portCell(port: PortInfo, clearance: number): GridPoint {
	const d = DIRECTION_INDEX[port.direction];
	return {
		gx: toGrid(port.position.x + DX[d] * clearance),
		gy: toGrid(port.position.y + DY[d] * clearance)
	};
}

function ray(from: GridPoint, dir: number, length: number): GridPoint[] {
	const cells: GridPoint[] = [];
	for (let k = 0; k <= length; k++) cells.push({ gx: from.gx + DX[dir] * k, gy: from.gy + DY[dir] * k });
	return cells;
}

function sameRect(a: GridRect, b: GridRect): boolean {
	return a.minGx === b.minGx && a.minGy === b.minGy && a.maxGx === b.maxGx && a.maxGy === b.maxGy;
}

function samePoints(a: GridPoint[], b: GridPoint[]): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) {
		if (a[i].gx !== b[i].gx || a[i].gy !== b[i].gy) return false;
	}
	return true;
}

function samePort(a: PortInfo, b: PortInfo): boolean {
	return a.direction === b.direction && a.position.x === b.position.x && a.position.y === b.position.y;
}

function sameRequest(a: RouteRequest, b: RouteRequest): boolean {
	if (a.netId !== b.netId || !samePort(a.source, b.source) || !samePort(a.target, b.target)) return false;
	if (a.waypoints.length !== b.waypoints.length) return false;
	for (let i = 0; i < a.waypoints.length; i++) {
		const p = a.waypoints[i].position;
		const q = b.waypoints[i].position;
		if (p.x !== q.x || p.y !== q.y) return false;
	}
	return true;
}

function samePath(a: RouteResult, b: RouteResult): boolean {
	if (a.isFallback !== b.isFallback || a.path.length !== b.path.length || a.waypoints !== b.waypoints) return false;
	for (let i = 0; i < a.path.length; i++) {
		if (a.path[i].x !== b.path[i].x || a.path[i].y !== b.path[i].y) return false;
	}
	return true;
}

function tileKey(tx: number, ty: number): number {
	return (tx + 0x8000) * 0x10000 + (ty + 0x8000);
}

/** Orthogonal fallback when no path exists: first along the start direction, then turn */
function fallbackCorners(from: GridPoint, to: GridPoint, dir: number): GridPoint[] {
	const corner = dir <= 1 ? { gx: to.gx, gy: from.gy } : { gx: from.gx, gy: to.gy };
	return [from, corner, to];
}

function sortedKeys(keys: Iterable<string>): string[] {
	return [...keys].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

export class RoutingEngine {
	private readonly map = new ObstacleMap();
	private readonly occupancy = new Occupancy();
	private readonly nodes = new Map<string, NodeEntry>();
	private readonly requests = new Map<string, RouteRequest>();
	private readonly raw = new Map<string, RawRoute>();
	/** Net id to connection ids */
	private readonly nets = new Map<string, Set<string>>();
	/** Cells each net currently holds in the occupancy */
	private readonly netCells = new Map<string, number[]>();
	private readonly routeTiles = new Map<number, Set<string>>();
	private readonly fallbacks = new Set<string>();
	private readonly dirty = new Set<string>();
	private readonly dirtyNets = new Set<string>();
	private readonly removedIds = new Set<string>();
	private results = new Map<string, RouteResult>();
	private changedSinceUpdate = false;
	private readonly congestion: boolean;
	private readonly nudge: boolean;

	constructor(options: RoutingEngineOptions = {}) {
		this.congestion = options.congestion ?? true;
		this.nudge = options.nudge ?? true;
	}

	/** Add or move a node together with its ports */
	setNode(id: string, bounds: Bounds, ports: PortStub[]): void {
		const entry: NodeEntry = { body: bodyRect(bounds), rect: marginRect(bounds), stubs: ports.map(stubCell) };
		const old = this.nodes.get(id);
		if (old && sameRect(old.rect, entry.rect) && samePoints(old.stubs, entry.stubs)) return;

		if (old) this.applyObstacles(old, -1);
		this.applyObstacles(entry, 1);
		this.nodes.set(id, entry);

		this.markAround(entry.rect);
		if (old) this.markAround(old.rect);
		this.retryFallbacks();
		this.changedSinceUpdate = true;
	}

	removeNode(id: string): void {
		const old = this.nodes.get(id);
		if (!old) return;
		this.applyObstacles(old, -1);
		this.nodes.delete(id);
		this.markAround(old.rect);
		this.retryFallbacks();
		this.changedSinceUpdate = true;
	}

	/** Add or change a connection */
	setRequest(request: RouteRequest): void {
		const old = this.requests.get(request.id);
		this.requests.set(request.id, request);
		this.removedIds.delete(request.id);
		if (old && sameRequest(old, request)) return;

		if (old && old.netId !== request.netId) this.leaveNet(old.netId, request.id);
		let members = this.nets.get(request.netId);
		if (!members) {
			members = new Set();
			this.nets.set(request.netId, members);
		}
		members.add(request.id);

		this.dirty.add(request.id);
		this.changedSinceUpdate = true;
	}

	removeRequest(id: string): void {
		const old = this.requests.get(id);
		if (!old) return;
		this.requests.delete(id);
		this.leaveNet(old.netId, id);
		this.dirty.delete(id);
		this.fallbacks.delete(id);
		this.unindex(id);
		this.raw.delete(id);
		this.removedIds.add(id);
		this.changedSinceUpdate = true;
	}

	hasRequest(id: string): boolean {
		return this.requests.has(id);
	}

	/** Search dirty nets, optionally negotiate overlaps, separate lanes and report what changed */
	update(options: UpdateOptions = {}): RoutingUpdate {
		const negotiate = options.negotiate ?? 0;
		if (!this.changedSinceUpdate && negotiate === 0) return { changed: new Map(), removed: [] };
		this.changedSinceUpdate = false;

		const nets = new Set(this.dirtyNets);
		for (const id of this.dirty) {
			const request = this.requests.get(id);
			if (request) nets.add(request.netId);
		}
		for (const netId of sortedKeys(nets)) this.routeNet(netId, false);
		this.dirty.clear();
		this.dirtyNets.clear();

		if (this.congestion) this.negotiate(negotiate);

		const next = this.finalize();
		const changed = new Map<string, RouteResult>();
		for (const [id, route] of next) {
			const prev = this.results.get(id);
			if (!prev || !samePath(prev, route)) changed.set(id, route);
		}
		const removed = [...this.removedIds];
		this.removedIds.clear();
		this.results = next;

		return { changed, removed };
	}

	getRoute(id: string): RouteResult | undefined {
		return this.results.get(id);
	}

	getRoutes(): Map<string, RouteResult> {
		return this.results;
	}

	private leaveNet(netId: string, id: string): void {
		const members = this.nets.get(netId);
		if (!members) return;
		members.delete(id);
		if (members.size === 0) this.nets.delete(netId);
		this.dirtyNets.add(netId);
	}

	/**
	 * Re-search connections of one net. Siblings keep or share their cells without
	 * congestion cost, so fan-out naturally forms a common trunk.
	 */
	private routeNet(netId: string, all: boolean): void {
		const previous = this.netCells.get(netId);
		if (previous) this.occupancy.add(previous, -1);
		this.netCells.delete(netId);

		const members = this.nets.get(netId);
		if (!members) return;
		const ids = sortedKeys(members);

		const cells = new Set<number>();
		const needsSearch = (id: string) => all || this.dirty.has(id) || !this.raw.has(id);
		for (const id of ids) {
			if (!needsSearch(id)) collectCells(this.raw.get(id)!.corners, cells);
		}

		this.occupancy.own = cells;
		for (const id of ids) {
			if (!needsSearch(id)) continue;
			const request = this.requests.get(id)!;
			this.unindex(id);
			const raw = this.search(request);
			this.raw.set(id, raw);
			if (raw.isFallback) this.fallbacks.add(id);
			else this.fallbacks.delete(id);
			this.index(id, raw);
			collectCells(raw.corners, cells);
		}
		this.occupancy.own = null;

		const list = [...cells];
		this.occupancy.add(list, 1);
		this.netCells.set(netId, list);
	}

	/**
	 * Re-search nets that share grid lines with other nets, with rising costs.
	 * Stops early when contention no longer drops, e.g. in gaps too narrow for
	 * separate lanes.
	 */
	private negotiate(iterations: number): void {
		let previousContested = Infinity;
		for (let iteration = 0; iteration < iterations; iteration++) {
			const conflicting: string[] = [];
			let contestedCells = 0;
			for (const [netId, cells] of this.netCells) {
				let contested = false;
				for (const key of cells) {
					if (this.occupancy.countKey(key) > 1) {
						this.occupancy.bumpHistory(key, HISTORY_COST);
						contestedCells++;
						contested = true;
					}
				}
				if (contested) conflicting.push(netId);
			}
			if (conflicting.length === 0 || contestedCells > previousContested * NEGOTIATION_PROGRESS) break;
			previousContested = contestedCells;

			this.occupancy.presentCost = PRESENT_COST * 2 ** (iteration + 1);
			for (const netId of sortedKeys(conflicting)) this.routeNet(netId, true);
		}
		this.occupancy.presentCost = PRESENT_COST;
	}

	private applyObstacles(entry: NodeEntry, delta: 1 | -1): void {
		this.map.addRect(entry.body, 'hard', delta);
		this.map.addRect(entry.rect, 'soft', delta);
		for (const s of entry.stubs) {
			this.map.addRect({ minGx: s.gx, minGy: s.gy, maxGx: s.gx, maxGy: s.gy }, 'soft', delta);
		}
	}

	private retryFallbacks(): void {
		for (const id of this.fallbacks) this.dirty.add(id);
	}

	/** Mark routes passing near a rectangle as dirty */
	private markAround(rect: GridRect): void {
		const minTx = Math.floor((rect.minGx - REROUTE_PADDING) / INDEX_TILE);
		const maxTx = Math.floor((rect.maxGx + REROUTE_PADDING) / INDEX_TILE);
		const minTy = Math.floor((rect.minGy - REROUTE_PADDING) / INDEX_TILE);
		const maxTy = Math.floor((rect.maxGy + REROUTE_PADDING) / INDEX_TILE);
		for (let tx = minTx; tx <= maxTx; tx++) {
			for (let ty = minTy; ty <= maxTy; ty++) {
				const ids = this.routeTiles.get(tileKey(tx, ty));
				if (ids) for (const id of ids) this.dirty.add(id);
			}
		}
	}

	private index(id: string, raw: RawRoute): void {
		const keys = new Set<number>();
		const pts = raw.corners;
		for (let i = 0; i < pts.length; i++) {
			const a = pts[i];
			const b = pts[Math.min(i + 1, pts.length - 1)];
			const minTx = Math.floor(Math.min(a.gx, b.gx) / INDEX_TILE);
			const maxTx = Math.floor(Math.max(a.gx, b.gx) / INDEX_TILE);
			const minTy = Math.floor(Math.min(a.gy, b.gy) / INDEX_TILE);
			const maxTy = Math.floor(Math.max(a.gy, b.gy) / INDEX_TILE);
			for (let tx = minTx; tx <= maxTx; tx++) {
				for (let ty = minTy; ty <= maxTy; ty++) keys.add(tileKey(tx, ty));
			}
		}
		raw.tiles = [...keys];
		for (const key of raw.tiles) {
			let ids = this.routeTiles.get(key);
			if (!ids) {
				ids = new Set();
				this.routeTiles.set(key, ids);
			}
			ids.add(id);
		}
	}

	private unindex(id: string): void {
		const raw = this.raw.get(id);
		if (!raw) return;
		for (const key of raw.tiles) {
			const ids = this.routeTiles.get(key);
			if (!ids) continue;
			ids.delete(id);
			if (ids.size === 0) this.routeTiles.delete(key);
		}
		raw.tiles = [];
	}

	private search(request: RouteRequest): RawRoute {
		const start = portCell(request.source, SOURCE_CLEARANCE);
		const end = portCell(request.target, TARGET_CLEARANCE);
		const startDir = DIRECTION_INDEX[request.source.direction];
		const targetDir = DIRECTION_INDEX[request.target.direction];
		const exit = ray(start, startDir, PORT_EXIT_CELLS);
		const entry = ray(end, targetDir, PORT_EXIT_CELLS);
		const congestion = this.congestion ? this.occupancy : undefined;

		const stops = request.waypoints.map((w) => ({ gx: toGrid(w.position.x), gy: toGrid(w.position.y) }));
		stops.push(end);

		const corners: GridPoint[] = [];
		let isFallback = false;
		let from = start;
		let dir = startDir;

		for (let k = 0; k < stops.length; k++) {
			const to = stops[k];
			const last = k === stops.length - 1;
			const forced = k === 0 ? [...exit, to] : [from, to];
			if (last) forced.push(...entry);

			const path = searchGridPath(this.map, {
				congestion,
				start: from,
				startDir: dir,
				end: to,
				endDir: last ? OPPOSITE[targetDir] : -1,
				forced
			});

			let leg: GridPoint[];
			if (path) {
				leg = path.corners;
				dir = path.arrivalDir;
			} else {
				isFallback = true;
				leg = fallbackCorners(from, to, dir);
			}
			const skipFirst = corners.length > 0 ? 1 : 0;
			for (let i = skipFirst; i < leg.length; i++) corners.push(leg[i]);
			from = to;
		}

		return { corners: simplifyGridPath(corners), isFallback, tiles: [] };
	}

	private finalize(): Map<string, RouteResult> {
		const routes: NudgeRoute[] = [];
		for (const [id, raw] of this.raw) {
			const request = this.requests.get(id)!;
			routes.push({
				id,
				netId: request.netId,
				points: raw.corners.map((p) => ({ gx: p.gx, gy: p.gy })),
				anchors: request.waypoints.map((w) => ({ gx: toGrid(w.position.x), gy: toGrid(w.position.y) }))
			});
		}

		if (this.nudge) nudgeRoutes(routes, this.map);

		const results = new Map<string, RouteResult>();
		for (const route of routes) {
			const request = this.requests.get(route.id)!;
			results.set(route.id, {
				path: route.points.map((p) => ({ x: fromGrid(p.gx), y: fromGrid(p.gy) })),
				waypoints: request.waypoints,
				isFallback: this.raw.get(route.id)!.isFallback
			});
		}
		return results;
	}
}

/** Route a complete scene in one go */
export function routeScene(
	scene: RoutingScene,
	options: RoutingEngineOptions & UpdateOptions = {}
): Map<string, RouteResult> {
	const engine = new RoutingEngine(options);
	for (const [id, node] of scene.nodes) engine.setNode(id, node.bounds, node.ports);
	for (const request of scene.requests) engine.setRequest(request);
	engine.update({ negotiate: options.negotiate ?? 3 });
	return engine.getRoutes();
}
