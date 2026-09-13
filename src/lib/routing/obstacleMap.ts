/**
 * Obstacle map - grid cells with obstacle reference counts, stored in tiles
 *
 * Two layers per cell: hard obstacles (node interiors) are impassable, soft
 * obstacles (node margins, cells in front of ports) are passable at extra cost.
 * Unbounded in all directions; reference counts let overlapping obstacles be
 * added and removed independently.
 */

import type { GridRect } from './gridTypes';

const TILE_BITS = 6;
const TILE_SIZE = 1 << TILE_BITS;
const TILE_MASK = TILE_SIZE - 1;

/** Cell value bits holding the hard obstacle count (the high byte counts soft ones) */
export const HARD_MASK = 0xff;

const LAYER_WEIGHT = { hard: 1, soft: 256 } as const;

export type ObstacleLayer = keyof typeof LAYER_WEIGHT;

function tileKey(tx: number, ty: number): number {
	return (tx + 0x8000) * 0x10000 + (ty + 0x8000);
}

export class ObstacleMap {
	private readonly tiles = new Map<number, Uint16Array>();
	private cachedKey = -1;
	private cachedTile: Uint16Array | undefined = undefined;

	/** Extent of all cells that were ever occupied (grows only) */
	readonly extent: GridRect = { minGx: 0, minGy: 0, maxGx: 0, maxGy: 0 };
	private hasExtent = false;

	/** Raw cell value: 0 when free, HARD_MASK bits set when impassable */
	cell(gx: number, gy: number): number {
		const key = tileKey(gx >> TILE_BITS, gy >> TILE_BITS);
		if (key !== this.cachedKey) {
			this.cachedKey = key;
			this.cachedTile = this.tiles.get(key);
		}
		const tile = this.cachedTile;
		return tile === undefined ? 0 : tile[((gy & TILE_MASK) << TILE_BITS) | (gx & TILE_MASK)];
	}

	isHard(gx: number, gy: number): boolean {
		return (this.cell(gx, gy) & HARD_MASK) !== 0;
	}

	/** True if no cell in the inclusive rectangle holds any obstacle */
	isFree(minGx: number, minGy: number, maxGx: number, maxGy: number): boolean {
		for (let gy = minGy; gy <= maxGy; gy++) {
			for (let gx = minGx; gx <= maxGx; gx++) {
				if (this.cell(gx, gy) !== 0) return false;
			}
		}
		return true;
	}

	/** Add (delta 1) or remove (delta -1) an obstacle rectangle on a layer */
	addRect(rect: GridRect, layer: ObstacleLayer, delta: 1 | -1): void {
		this.cachedKey = -1;
		if (delta > 0) this.grow(rect);
		const step = LAYER_WEIGHT[layer] * delta;

		for (let gy = rect.minGy; gy <= rect.maxGy; gy++) {
			for (let gx = rect.minGx; gx <= rect.maxGx; gx++) {
				const key = tileKey(gx >> TILE_BITS, gy >> TILE_BITS);
				let tile = this.tiles.get(key);
				if (!tile) {
					if (delta < 0) continue;
					tile = new Uint16Array(TILE_SIZE * TILE_SIZE);
					this.tiles.set(key, tile);
				}
				tile[((gy & TILE_MASK) << TILE_BITS) | (gx & TILE_MASK)] += step;
			}
		}
	}

	private grow(rect: GridRect): void {
		const e = this.extent;
		if (!this.hasExtent) {
			Object.assign(e, rect);
			this.hasExtent = true;
			return;
		}
		e.minGx = Math.min(e.minGx, rect.minGx);
		e.minGy = Math.min(e.minGy, rect.minGy);
		e.maxGx = Math.max(e.maxGx, rect.maxGx);
		e.maxGy = Math.max(e.maxGy, rect.maxGy);
	}
}
