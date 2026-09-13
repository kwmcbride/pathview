/**
 * Routing protocol - scene differences to the engine, route changes back
 */

import type { RouteRequest, RouteResult, SceneNode } from './types';
import type { RoutingEngine } from './engine';

export interface RoutingDelta {
	/** Increments on reset; responses of older epochs are dropped */
	epoch: number;
	/** Discard the whole scene before applying this delta */
	reset: boolean;
	nodes: [string, SceneNode][];
	removedNodes: string[];
	requests: RouteRequest[];
	removedRequests: string[];
	/** Negotiation iterations after applying the delta */
	negotiate: number;
}

export interface RoutingResponse {
	epoch: number;
	changed: [string, RouteResult][];
	removed: string[];
}

/** Apply a delta to an engine and collect the resulting route changes */
export function applyDelta(engine: RoutingEngine, delta: RoutingDelta): RoutingResponse {
	for (const id of delta.removedRequests) engine.removeRequest(id);
	for (const id of delta.removedNodes) engine.removeNode(id);
	for (const [id, node] of delta.nodes) engine.setNode(id, node.bounds, node.ports);
	for (const request of delta.requests) engine.setRequest(request);
	const update = engine.update({ negotiate: delta.negotiate });
	return { epoch: delta.epoch, changed: [...update.changed], removed: update.removed };
}
