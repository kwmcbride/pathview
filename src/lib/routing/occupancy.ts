/**
 * Occupancy - grid usage by nets for negotiated congestion routing
 *
 * Counts how many nets run through each cell, separately per axis, so that
 * crossings stay cheap while running along another net costs extra. A history
 * term raises the cost of cells that stayed contested across iterations.
 */

import type { GridPoint } from './gridTypes';
import type { CongestionCosts } from './search';

const TILE_BITS = 6;
const TILE_SIZE = 1 << TILE_BITS;
const TILE_MASK = TILE_SIZE - 1;

const KEY_OFFSET = 1 << 20;
const KEY_SPAN = 1 << 21;

/** Axis of a unit step: 0 horizontal, 1 vertical */
export type Axis = 0 | 1;

function tileKey(tx: number, ty: number): number {
	return (tx + 0x8000) * 0x10000 + (ty + 0x8000);
}

/** Numeric key of a cell on one axis */
export function cellKey(gx: number, gy: number, axis: Axis): number {
	return ((gx + KEY_OFFSET) * KEY_SPAN + (gy + KEY_OFFSET)) * 2 + axis;
}

/** Add the cell keys covered by a corner path */
export function collectCells(points: GridPoint[], into: Set<number>): void {
	for (let i = 0; i < points.length - 1; i++) {
		const a = points[i];
		const b = points[i + 1];
		if (a.gy === b.gy) {
			for (let x = Math.min(a.gx, b.gx); x <= Math.max(a.gx, b.gx); x++) into.add(cellKey(x, a.gy, 0));
		} else {
			for (let y = Math.min(a.gy, b.gy); y <= Math.max(a.gy, b.gy); y++) into.add(cellKey(a.gx, y, 1));
		}
	}
}

class TileCounts {
	private readonly tiles = new Map<number, Uint16Array>();
	private cachedKey = -1;
	private cachedTile: Uint16Array | undefined = undefined;

	get(gx: number, gy: number, axis: Axis): number {
		const key = tileKey(gx >> TILE_BITS, gy >> TILE_BITS);
		if (key !== this.cachedKey) {
			this.cachedKey = key;
			this.cachedTile = this.tiles.get(key);
		}
		const tile = this.cachedTile;
		return tile === undefined ? 0 : tile[((((gy & TILE_MASK) << TILE_BITS) | (gx & TILE_MASK)) << 1) | axis];
	}

	add(gx: number, gy: number, axis: Axis, delta: number): void {
		const key = tileKey(gx >> TILE_BITS, gy >> TILE_BITS);
		let tile = this.tiles.get(key);
		if (!tile) {
			if (delta < 0) return;
			tile = new Uint16Array(TILE_SIZE * TILE_SIZE * 2);
			this.tiles.set(key, tile);
			this.cachedKey = -1;
		}
		const index = ((((gy & TILE_MASK) << TILE_BITS) | (gx & TILE_MASK)) << 1) | axis;
		tile[index] = Math.max(0, Math.min(0xffff, tile[index] + delta));
	}
}

function decode(key: number): [number, number, Axis] {
	const axis = (key % 2) as Axis;
	const cell = (key - axis) / 2;
	const gy = (cell % KEY_SPAN) - KEY_OFFSET;
	const gx = Math.floor(cell / KEY_SPAN) - KEY_OFFSET;
	return [gx, gy, axis];
}

export class Occupancy implements CongestionCosts {
	private readonly usage = new TileCounts();
	private readonly history = new TileCounts();

	/** Cost per other net using a cell on the same axis */
	presentCost = 2;

	/** Cells of the net currently being routed; they carry no congestion cost */
	own: Set<number> | null = null;

	add(keys: Iterable<number>, delta: 1 | -1): void {
		for (const key of keys) {
			const [gx, gy, axis] = decode(key);
			this.usage.add(gx, gy, axis, delta);
		}
	}

	countKey(key: number): number {
		const [gx, gy, axis] = decode(key);
		return this.usage.get(gx, gy, axis);
	}

	bumpHistory(key: number, amount: number): void {
		const [gx, gy, axis] = decode(key);
		this.history.add(gx, gy, axis, amount);
	}

	penalty(gx: number, gy: number, axis: Axis): number {
		const used = this.usage.get(gx, gy, axis);
		const past = this.history.get(gx, gy, axis);
		if (used === 0 && past === 0) return 0;
		if (this.own !== null && this.own.has(cellKey(gx, gy, axis))) return 0;
		return used * this.presentCost + past;
	}
}
