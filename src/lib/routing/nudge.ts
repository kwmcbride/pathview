/**
 * Lane separation (nudging)
 *
 * Routes are searched independently, so segments of different nets can end up
 * on the same grid line. This pass moves inner segments of overlapping nets onto
 * neighbouring free grid lines, ordered to avoid crossings. Segments attached to
 * ports or passing through user waypoints stay in place.
 */

import type { ObstacleMap } from './obstacleMap';
import type { GridPoint } from './gridTypes';

export interface NudgeRoute {
	id: string;
	netId: string;
	/** Corner points, modified in place */
	points: GridPoint[];
	/** Grid points the route has to keep passing through */
	anchors: GridPoint[];
}

/** Maximum lane distance from the original line, in grid cells */
const MAX_LANE = 8;

interface Segment {
	route: NudgeRoute;
	/** The segment runs from points[index] to points[index + 1] */
	index: number;
	lo: number;
	hi: number;
	fixed: boolean;
}

interface Unit {
	netId: string;
	segments: Segment[];
	lo: number;
	hi: number;
	fixed: boolean;
	/** Direction of the leg at the low and high end: -1, 0 (none) or 1 */
	loDir: number;
	hiDir: number;
}

/** Axis accessors so one pass implementation serves both orientations */
interface Axis {
	along(p: GridPoint): number;
	across(p: GridPoint): number;
	setAcross(p: GridPoint, value: number): void;
	/** Obstacle-free cells from a to b (inclusive) along the line `line` */
	lineFree(map: ObstacleMap, line: number, a: number, b: number): boolean;
	/** Obstacle-free cells from a to b (inclusive) on the perpendicular line at `along` */
	legFree(map: ObstacleMap, along: number, a: number, b: number): boolean;
}

const HORIZONTAL: Axis = {
	along: (p) => p.gx,
	across: (p) => p.gy,
	setAcross: (p, v) => {
		p.gy = v;
	},
	lineFree: (map, line, a, b) => map.isFree(Math.min(a, b), line, Math.max(a, b), line),
	legFree: (map, along, a, b) => map.isFree(along, Math.min(a, b), along, Math.max(a, b))
};

const VERTICAL: Axis = {
	along: (p) => p.gy,
	across: (p) => p.gx,
	setAcross: (p, v) => {
		p.gx = v;
	},
	lineFree: (map, line, a, b) => map.isFree(line, Math.min(a, b), line, Math.max(a, b)),
	legFree: (map, along, a, b) => map.isFree(Math.min(a, b), along, Math.max(a, b), along)
};

/**
 * Separate overlapping segments of different nets.
 * Routes are modified in place.
 */
export function nudgeRoutes(routes: NudgeRoute[], map: ObstacleMap): void {
	nudgePass(routes, map, HORIZONTAL);
	nudgePass(routes, map, VERTICAL);
	// Moving vertical segments stretches horizontal ones, which can create new overlaps
	nudgePass(routes, map, HORIZONTAL);
	for (const route of routes) route.points = simplifyGridPath(route.points);
}

function nudgePass(routes: NudgeRoute[], map: ObstacleMap, axis: Axis): void {
	const lines = new Map<number, Segment[]>();

	for (const route of routes) {
		const pts = route.points;
		const last = pts.length - 1;
		for (let i = 0; i < last; i++) {
			const a = pts[i];
			const b = pts[i + 1];
			const line = axis.across(a);
			if (line !== axis.across(b) || axis.along(a) === axis.along(b)) continue;

			const lo = Math.min(axis.along(a), axis.along(b));
			const hi = Math.max(axis.along(a), axis.along(b));
			const fixed =
				i === 0 ||
				i + 1 === last ||
				route.anchors.some((p) => axis.across(p) === line && axis.along(p) >= lo && axis.along(p) <= hi);

			let list = lines.get(line);
			if (!list) {
				list = [];
				lines.set(line, list);
			}
			list.push({ route, index: i, lo, hi, fixed });
		}
	}

	const lineKeys = [...lines.keys()].sort((a, b) => a - b);
	for (const line of lineKeys) {
		const segments = lines.get(line)!;
		if (segments.length < 2) continue;

		const sorted = segments
			.slice()
			.sort((a, b) => a.lo - b.lo || a.hi - b.hi || compareIds(a.route.id, b.route.id) || a.index - b.index);

		let cluster: Segment[] = [];
		let clusterHi = -Infinity;
		for (const segment of sorted) {
			if (cluster.length > 0 && segment.lo > clusterHi) {
				resolveCluster(cluster, line, lines, map, axis);
				cluster = [];
				clusterHi = -Infinity;
			}
			cluster.push(segment);
			clusterHi = Math.max(clusterHi, segment.hi);
		}
		resolveCluster(cluster, line, lines, map, axis);
	}
}

function compareIds(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

function legDirection(segment: Segment, atLow: boolean, line: number, axis: Axis): number {
	const pts = segment.route.points;
	const a = pts[segment.index];
	const b = pts[segment.index + 1];
	const lowIsFirst = axis.along(a) <= axis.along(b);
	const other = lowIsFirst === atLow ? pts[segment.index - 1] : pts[segment.index + 2];
	return other ? Math.sign(axis.across(other) - line) : 0;
}

function buildUnits(cluster: Segment[], line: number, axis: Axis): Unit[] {
	const byNet = new Map<string, Segment[]>();
	for (const segment of cluster) {
		const list = byNet.get(segment.route.netId);
		if (list) list.push(segment);
		else byNet.set(segment.route.netId, [segment]);
	}

	const units: Unit[] = [];
	for (const [netId, segments] of byNet) {
		let low = segments[0];
		let high = segments[0];
		for (const s of segments) {
			if (s.lo < low.lo) low = s;
			if (s.hi > high.hi) high = s;
		}
		units.push({
			netId,
			segments,
			lo: low.lo,
			hi: high.hi,
			fixed: segments.some((s) => s.fixed),
			loDir: legDirection(low, true, line, axis),
			hiDir: legDirection(high, false, line, axis)
		});
	}
	return units;
}

/**
 * Order units across the line: negative means `a` belongs on the lower side.
 * Legs turning towards a side pull their unit to that side; for equal turns the
 * unit whose leg is further inside the shared range goes outward, which avoids
 * a crossing with the other unit's leg.
 */
function compareUnits(a: Unit, b: Unit): number {
	let score = 0;
	if (a.loDir !== b.loDir) score += a.loDir - b.loDir;
	else if (a.loDir !== 0) score += a.loDir * Math.sign(a.lo - b.lo);
	if (a.hiDir !== b.hiDir) score += a.hiDir - b.hiDir;
	else if (a.hiDir !== 0) score += a.hiDir * Math.sign(b.hi - a.hi);
	return Math.sign(score) || compareIds(a.netId, b.netId);
}

function resolveCluster(
	cluster: Segment[],
	line: number,
	lines: Map<number, Segment[]>,
	map: ObstacleMap,
	axis: Axis
): void {
	if (cluster.length < 2) return;
	const units = buildUnits(cluster, line, axis);
	if (units.length < 2) return;

	units.sort(compareUnits);

	// Lane assignment like interval colouring: a unit only moves when it overlaps a
	// unit that already holds a lane, and it moves to the side given by the order.
	const placed: { unit: Unit; order: number; offset: number }[] = [];
	units.forEach((unit, order) => {
		if (unit.fixed) placed.push({ unit, order, offset: 0 });
	});

	units.forEach((unit, order) => {
		if (unit.fixed) return;
		const overlapping = placed.filter((p) => p.unit.hi >= unit.lo && p.unit.lo <= unit.hi);
		if (overlapping.length === 0) {
			placed.push({ unit, order, offset: 0 });
			return;
		}
		const below = overlapping.every((p) => p.order > order);
		const start = below
			? Math.min(...overlapping.map((p) => p.offset)) - 1
			: Math.max(...overlapping.map((p) => p.offset)) + 1;
		if (start === 0 && !overlapping.some((p) => p.offset === 0)) {
			placed.push({ unit, order, offset: 0 });
			return;
		}
		const offset = moveUnit(unit, line, start, below ? -1 : 1, lines, map, axis);
		placed.push({ unit, order, offset });
	});
}

/** Move a unit to the nearest feasible lane from `start` outwards. Returns the offset, 0 if it stays. */
function moveUnit(
	unit: Unit,
	line: number,
	start: number,
	side: number,
	lines: Map<number, Segment[]>,
	map: ObstacleMap,
	axis: Axis
): number {
	for (let offset = start; Math.abs(offset) <= MAX_LANE; offset += side) {
		if (offset === 0) continue;
		const target = line + offset;
		if (!isFeasible(unit, line, target, lines, map, axis)) continue;

		for (const segment of unit.segments) {
			const pts = segment.route.points;
			axis.setAcross(pts[segment.index], target);
			axis.setAcross(pts[segment.index + 1], target);
			segment.fixed = true;

			const from = lines.get(line)!;
			from.splice(from.indexOf(segment), 1);
			let to = lines.get(target);
			if (!to) {
				to = [];
				lines.set(target, to);
			}
			to.push(segment);
		}
		return offset;
	}
	return 0;
}

function isFeasible(
	unit: Unit,
	line: number,
	target: number,
	lines: Map<number, Segment[]>,
	map: ObstacleMap,
	axis: Axis
): boolean {
	const occupants = lines.get(target);

	for (const segment of unit.segments) {
		const pts = segment.route.points;
		const a = pts[segment.index];
		const b = pts[segment.index + 1];
		const before = pts[segment.index - 1];
		const after = pts[segment.index + 2];

		// Legs keep their orientation and a non-zero length
		for (const far of [before, after]) {
			const farAcross = axis.across(far);
			if (target === farAcross || Math.sign(line - farAcross) !== Math.sign(target - farAcross)) return false;
		}

		if (!axis.lineFree(map, target, segment.lo, segment.hi)) return false;
		if (!legExtensionFree(map, axis, axis.along(a), axis.across(before), line, target)) return false;
		if (!legExtensionFree(map, axis, axis.along(b), axis.across(after), line, target)) return false;

		if (occupants) {
			for (const other of occupants) {
				if (other.route.netId !== unit.netId && other.hi >= segment.lo && other.lo <= segment.hi) return false;
			}
		}
	}
	return true;
}

/** Check only the cells a leg gains when its end moves from `line` to `target` */
function legExtensionFree(
	map: ObstacleMap,
	axis: Axis,
	along: number,
	far: number,
	line: number,
	target: number
): boolean {
	if (Math.abs(target - far) <= Math.abs(line - far)) return true;
	const step = Math.sign(target - line);
	return axis.legFree(map, along, line + step, target);
}

/** Remove duplicate and collinear points */
export function simplifyGridPath(points: GridPoint[]): GridPoint[] {
	const result: GridPoint[] = [];
	for (const p of points) {
		const last = result[result.length - 1];
		if (last && last.gx === p.gx && last.gy === p.gy) continue;
		if (result.length >= 2) {
			const prev = result[result.length - 2];
			if ((prev.gx === last.gx && last.gx === p.gx) || (prev.gy === last.gy && last.gy === p.gy)) {
				result[result.length - 1] = p;
				continue;
			}
		}
		result.push(p);
	}
	return result;
}
