/**
 * Routing module public API
 */

// Engine and worker client
export { RoutingEngine, routeScene } from './engine';
export { RoutingClient, type RoutingChanges } from './client';

// Scene comparisons
export { sameRequest, sameSceneNode } from './scene';

// Port geometry
export { getPortInfo } from './portGeometry';

// Constants used by canvas and edges
export {
	ROUTING_MARGIN,
	HANDLE_OFFSET,
	ARROW_INSET,
	WAYPOINT_MERGE_THRESHOLD,
	WAYPOINT_COLLINEAR_THRESHOLD,
	EDGE_SOURCE_OFFSET,
	EDGE_TARGET_OFFSET,
	EDGE_CORNER_RADIUS
} from './constants';

// Types
export type {
	Bounds,
	RouteResult,
	Direction,
	PortStub,
	PortInfo,
	RouteRequest,
	RoutingScene,
	SceneNode
} from './types';
