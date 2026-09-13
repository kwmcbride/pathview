/**
 * Routing-specific type definitions
 */

import type { Position } from '$lib/types/common';
import type { Waypoint } from '$lib/types/nodes';

/** Direction a port faces (for enforcing entry/exit angles) */
export type Direction = 'up' | 'down' | 'left' | 'right';

/** Direction vectors for each direction */
export const DIRECTION_VECTORS: Record<Direction, Position> = {
	up: { x: 0, y: -1 },
	down: { x: 0, y: 1 },
	left: { x: -1, y: 0 },
	right: { x: 1, y: 0 }
};

/** Opposite direction mapping (for 180-degree turn blocking) */
export const OPPOSITE_DIRECTION: Record<Direction, Direction> = {
	up: 'down',
	down: 'up',
	left: 'right',
	right: 'left'
};

/** Rectangle bounds for obstacle detection */
export interface Bounds {
	x: number;
	y: number;
	width: number;
	height: number;
}

/** Port stub for obstacle marking */
export interface PortStub {
	position: Position;
	direction: Direction;
}

/** Port handle tip position and facing direction in world coordinates */
export interface PortInfo {
	position: Position;
	direction: Direction;
}

/** One connection to route */
export interface RouteRequest {
	id: string;
	/** Connections from the same output port share a net and may share grid cells */
	netId: string;
	source: PortInfo;
	target: PortInfo;
	/** User waypoints in route order */
	waypoints: Waypoint[];
}

/** Routing input for one node: obstacle bounds and all its ports */
export interface SceneNode {
	bounds: Bounds;
	ports: PortStub[];
}

/** Complete routing input: nodes and connections */
export interface RoutingScene {
	nodes: Map<string, SceneNode>;
	requests: RouteRequest[];
}

/** Result from route calculation */
export interface RouteResult {
	/** Grid-aligned points including source/target */
	path: Position[];
	/** User waypoints (for future use) */
	waypoints: Waypoint[];
	/** True if this is a fallback path (A* failed) - should not be cached */
	isFallback?: boolean;
}
