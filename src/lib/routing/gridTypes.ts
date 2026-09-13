/**
 * Grid primitives shared by the routing engine
 */

import type { Direction } from './types';
import { GRID_SIZE } from './constants';

/** Cell in grid coordinates */
export interface GridPoint {
	gx: number;
	gy: number;
}

/** Inclusive rectangle in grid coordinates */
export interface GridRect {
	minGx: number;
	minGy: number;
	maxGx: number;
	maxGy: number;
}

/** Direction indices */
export const RIGHT = 0;
export const LEFT = 1;
export const DOWN = 2;
export const UP = 3;

export const DX: readonly number[] = [1, -1, 0, 0];
export const DY: readonly number[] = [0, 0, 1, -1];
export const OPPOSITE: readonly number[] = [LEFT, RIGHT, UP, DOWN];

export const DIRECTION_INDEX: Record<Direction, number> = { right: RIGHT, left: LEFT, down: DOWN, up: UP };

/** World coordinate to grid coordinate (nearest grid line) */
export function toGrid(value: number): number {
	return Math.round(value / GRID_SIZE);
}

/** Grid coordinate to world coordinate */
export function fromGrid(value: number): number {
	return value * GRID_SIZE;
}
