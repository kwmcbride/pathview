/**
 * Port geometry - single source for port handle positions in world coordinates
 */

import type { Position, RotationValue } from '$lib/types/common';
import type { Direction, PortInfo } from './types';
import { getPortOffset } from '$lib/constants/dimensions';
import { HANDLE_OFFSET, ARROW_INSET } from './constants';

/** Facing direction of output ports per rotation */
const OUTPUT_DIRECTION: Record<RotationValue, Direction> = { 0: 'right', 1: 'down', 2: 'left', 3: 'up' };

/** Facing direction of input ports per rotation (opposite side of outputs) */
const INPUT_DIRECTION: Record<RotationValue, Direction> = { 0: 'left', 1: 'up', 2: 'right', 3: 'down' };

/**
 * Get the handle tip position and facing direction of a port.
 * Input tips are pulled back by the arrow inset so route stubs end inside the arrowhead.
 *
 * @param center - Node center (nodes use origin [0.5, 0.5])
 * @param width - Node width
 * @param height - Node height
 * @param rotation - Node rotation (0-3)
 * @param index - Port index on its side
 * @param count - Number of ports on that side
 * @param isOutput - Output (source) or input (target) port
 */
export function getPortInfo(
	center: Position,
	width: number,
	height: number,
	rotation: RotationValue,
	index: number,
	count: number,
	isOutput: boolean
): PortInfo {
	const direction = isOutput ? OUTPUT_DIRECTION[rotation] : INPUT_DIRECTION[rotation];
	const along = getPortOffset(index, count);
	const out = isOutput ? HANDLE_OFFSET : HANDLE_OFFSET + ARROW_INSET;

	switch (direction) {
		case 'right':
			return { position: { x: center.x + width / 2 + out, y: center.y + along }, direction };
		case 'left':
			return { position: { x: center.x - width / 2 - out, y: center.y + along }, direction };
		case 'down':
			return { position: { x: center.x + along, y: center.y + height / 2 + out }, direction };
		case 'up':
			return { position: { x: center.x + along, y: center.y - height / 2 - out }, direction };
	}
}
