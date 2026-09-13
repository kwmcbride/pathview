/**
 * Routing store - connects the canvas to the routing engine
 *
 * The canvas reports its scene (block nodes with ports, connections). The store
 * remembers what was sent, forwards only differences to the routing worker and
 * keeps the returned routes in a reactive map, so an edge re-renders only when
 * its own route changes. Waypoint edits change the graph; the resulting
 * connection change is routed like any other.
 */

import { get } from 'svelte/store';
import { SvelteMap } from 'svelte/reactivity';
import type { Position } from '$lib/types/common';
import type { Connection, Waypoint } from '$lib/types/nodes';
import {
	RoutingClient,
	sameRequest,
	sameSceneNode,
	WAYPOINT_MERGE_THRESHOLD,
	WAYPOINT_COLLINEAR_THRESHOLD,
	type Bounds,
	type PortInfo,
	type RouteRequest,
	type RouteResult,
	type RoutingChanges,
	type SceneNode
} from '$lib/routing';
import { generateId } from '$lib/stores/utils';
import { graphStore } from '$lib/stores/graph';
import { historyStore } from '$lib/stores/history';

export type { PortInfo };

/** Minimum number of changed connections for routing the visible ones in a separate first round */
const VISIBLE_FIRST_MIN = 200;

const routes = new SvelteMap<string, RouteResult>();
const sentNodes = new Map<string, SceneNode>();
const sentRequests = new Map<string, RouteRequest>();

const client = new RoutingClient((response) => {
	for (const [id, route] of response.changed) {
		if (sentRequests.has(id)) routes.set(id, route);
	}
	for (const id of response.removed) routes.delete(id);
});

function intersects(request: RouteRequest, area: Bounds): boolean {
	const a = request.source.position;
	const b = request.target.position;
	return (
		Math.max(a.x, b.x) >= area.x &&
		Math.min(a.x, b.x) <= area.x + area.width &&
		Math.max(a.y, b.y) >= area.y &&
		Math.min(a.y, b.y) <= area.y + area.height
	);
}

function findConnection(connectionId: string): Connection | undefined {
	return get(graphStore.connections).find((c) => c.id === connectionId);
}

function userWaypoints(waypoints?: Waypoint[]): Waypoint[] {
	return (waypoints ?? []).filter((w) => w.isUserWaypoint);
}

function distance(a: Position, b: Position): number {
	return Math.hypot(a.x - b.x, a.y - b.y);
}

/** Middle point lies (almost) on the line between its neighbours */
function isCollinear(prev: Position, curr: Position, next: Position): boolean {
	const dx = next.x - prev.x;
	const dy = next.y - prev.y;
	const length = Math.hypot(dx, dy);
	if (length < 1) return true;
	const cross = Math.abs((curr.x - prev.x) * dy - (curr.y - prev.y) * dx);
	return cross / length < WAYPOINT_COLLINEAR_THRESHOLD;
}

export const routingStore = {
	/** Route of a connection, reactive per connection */
	route(connectionId: string): RouteResult | undefined {
		return routes.get(connectionId);
	},

	/**
	 * Compare nodes with what was sent before and remember them. Returns the changed
	 * nodes; with `complete`, previously sent nodes missing from the list are removed.
	 */
	diffNodes(nodes: [string, SceneNode][], complete: boolean): { changed: [string, SceneNode][]; removed: string[] } {
		const changed: [string, SceneNode][] = [];
		for (const entry of nodes) {
			if (sameSceneNode(sentNodes.get(entry[0]), entry[1])) continue;
			changed.push(entry);
			sentNodes.set(entry[0], entry[1]);
		}

		const removed: string[] = [];
		if (complete) {
			const listed = new Set(nodes.map(([id]) => id));
			for (const id of sentNodes.keys()) {
				if (!listed.has(id)) removed.push(id);
			}
			for (const id of removed) sentNodes.delete(id);
		}
		return { changed, removed };
	},

	/** Send scene changes; with many changed connections, those crossing `visible` are routed first */
	send(changes: RoutingChanges, visible?: Bounds | null): void {
		const requests = changes.requests.filter((r) => !sameRequest(sentRequests.get(r.id), r));
		for (const request of requests) sentRequests.set(request.id, request);
		for (const id of changes.removedRequests) {
			sentRequests.delete(id);
			routes.delete(id);
		}

		const structure = {
			nodes: changes.nodes,
			removedNodes: changes.removedNodes,
			removedRequests: changes.removedRequests
		};
		if (visible && requests.length >= VISIBLE_FIRST_MIN) {
			client.send({ ...structure, requests: requests.filter((r) => intersects(r, visible)) });
			client.send({
				nodes: [],
				removedNodes: [],
				removedRequests: [],
				requests: requests.filter((r) => !intersects(r, visible))
			});
		} else {
			client.send({ ...structure, requests });
		}
	},

	/** Forget the scene and all routes */
	reset(): void {
		sentNodes.clear();
		sentRequests.clear();
		routes.clear();
		client.reset();
	},

	addUserWaypoint(connectionId: string, position: Position): string | null {
		let waypointId: string | null = null;
		historyStore.mutate(() => {
			const connection = findConnection(connectionId);
			if (!connection) return;
			const id = generateId();
			waypointId = id;
			graphStore.updateConnectionWaypoints(connectionId, [
				...userWaypoints(connection.waypoints),
				{ id, position, isUserWaypoint: true }
			]);
		});
		return waypointId;
	},

	/** Insert a user waypoint at a position in the route order (segment dragging) */
	addUserWaypointAtIndex(connectionId: string, position: Position, insertIndex: number): string | null {
		let waypointId: string | null = null;
		historyStore.mutate(() => {
			const connection = findConnection(connectionId);
			if (!connection) return;
			const id = generateId();
			waypointId = id;
			const existing = userWaypoints(connection.waypoints);
			graphStore.updateConnectionWaypoints(connectionId, [
				...existing.slice(0, insertIndex),
				{ id, position, isUserWaypoint: true },
				...existing.slice(insertIndex)
			]);
		});
		return waypointId;
	},

	removeUserWaypoint(connectionId: string, waypointId: string): void {
		historyStore.mutate(() => {
			const connection = findConnection(connectionId);
			if (!connection?.waypoints) return;
			graphStore.updateConnectionWaypoints(
				connectionId,
				connection.waypoints.filter((w) => w.id !== waypointId || !w.isUserWaypoint)
			);
		});
	},

	/**
	 * Move a waypoint. Not wrapped in historyStore.mutate: the caller owns the drag
	 * transaction, so a whole drag becomes one undo entry.
	 */
	moveWaypoint(connectionId: string, waypointId: string, position: Position): void {
		const connection = findConnection(connectionId);
		if (!connection?.waypoints) return;
		graphStore.updateConnectionWaypoints(
			connectionId,
			connection.waypoints.map((w) => (w.id === waypointId ? { ...w, position } : w))
		);
	},

	/** After a waypoint drag: merge waypoints that are too close and drop collinear ones */
	cleanupWaypoints(
		connectionId: string,
		getPortInfo?: (nodeId: string, portIndex: number, isOutput: boolean) => PortInfo | null
	): void {
		const connection = findConnection(connectionId);
		if (!connection) return;
		const waypoints = userWaypoints(connection.waypoints);
		if (waypoints.length === 0) return;

		const source = getPortInfo?.(connection.sourceNodeId, connection.sourcePortIndex, true)?.position;
		const target = getPortInfo?.(connection.targetNodeId, connection.targetPortIndex, false)?.position;

		// Keep the earlier of two waypoints that are too close together
		const merged = waypoints.filter(
			(w, i) => i === 0 || distance(w.position, waypoints[i - 1].position) >= WAYPOINT_MERGE_THRESHOLD
		);

		const points = [...(source ? [source] : []), ...merged.map((w) => w.position), ...(target ? [target] : [])];
		const offset = source ? 1 : 0;
		const cleaned = merged.filter((w, i) => {
			const prev = points[i + offset - 1];
			const next = points[i + offset + 1];
			return !(prev && next && isCollinear(prev, w.position, next));
		});

		if (cleaned.length !== waypoints.length) {
			graphStore.updateConnectionWaypoints(connectionId, cleaned);
		}
	},

	/** Remove all user waypoints of a connection */
	resetRoute(connectionId: string): void {
		historyStore.mutate(() => {
			graphStore.updateConnectionWaypoints(connectionId, []);
		});
	}
};
