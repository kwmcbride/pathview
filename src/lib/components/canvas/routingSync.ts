/**
 * Routing sync - reports the canvas scene to the routing store
 *
 * Builds routing input from SvelteFlow block nodes and graph connections. Node
 * geometry is diffed on every sync and connections by identity, so only changed
 * nodes and the connections attached to them are sent to the routing engine.
 */

import type { Node } from '@xyflow/svelte';
import type { Position, RotationValue } from '$lib/types/common';
import type { Connection, NodeInstance } from '$lib/nodes/types';
import type { Bounds, PortInfo, PortStub, RouteRequest, SceneNode } from '$lib/routing';
import { getPortInfo } from '$lib/routing';
import { DEFAULT_NODE_WIDTH, DEFAULT_NODE_HEIGHT } from '$lib/constants/dimensions';
import { routingStore } from '$lib/stores/routing';

export interface RoutingSyncSource {
	/** Block nodes currently shown on the canvas */
	blockNodes(): Node[];
	node(id: string): Node | undefined;
	/** Connections of the current graph level */
	connections(): Connection[];
	/** Visible canvas area in flow coordinates, routed first */
	visibleBounds(): Bounds | null;
}

function nodeSize(node: Node): { width: number; height: number } {
	return {
		width: node.measured?.width ?? node.width ?? DEFAULT_NODE_WIDTH,
		height: node.measured?.height ?? node.height ?? DEFAULT_NODE_HEIGHT
	};
}

function nodeRotation(node: Node): RotationValue {
	return (((node.data as NodeInstance).params?.['_rotation'] as number) || 0) as RotationValue;
}

/** Port handle tip of a block node, optionally at an overridden position */
export function blockPortInfo(
	node: Node,
	index: number,
	isOutput: boolean,
	position: Position = node.position
): PortInfo | null {
	const data = node.data as NodeInstance;
	const count = isOutput ? data.outputs.length : data.inputs.length;
	if (index >= count) return null;
	const { width, height } = nodeSize(node);
	return getPortInfo(position, width, height, nodeRotation(node), index, count, isOutput);
}

function sceneNodeOf(node: Node, position: Position = node.position): SceneNode {
	const data = node.data as NodeInstance;
	const { width, height } = nodeSize(node);
	const rotation = nodeRotation(node);
	const ports: PortStub[] = [];
	for (let i = 0; i < data.inputs.length; i++) {
		ports.push(getPortInfo(position, width, height, rotation, i, data.inputs.length, false));
	}
	for (let i = 0; i < data.outputs.length; i++) {
		ports.push(getPortInfo(position, width, height, rotation, i, data.outputs.length, true));
	}
	return { bounds: { x: position.x - width / 2, y: position.y - height / 2, width, height }, ports };
}

export function createRoutingSync(source: RoutingSyncSource) {
	/** Connections as last reported, compared by identity */
	let routed = new Map<string, Connection>();
	let byNode = new Map<string, Connection[]>();

	function indexByNode(connections: Connection[]): void {
		byNode = new Map();
		for (const c of connections) {
			for (const id of [c.sourceNodeId, c.targetNodeId]) {
				const list = byNode.get(id);
				if (list) list.push(c);
				else byNode.set(id, [c]);
			}
		}
	}

	function collectAttached(nodeIds: Iterable<string>, into: Map<string, Connection>): void {
		for (const id of nodeIds) {
			for (const c of byNode.get(id) ?? []) into.set(c.id, c);
		}
	}

	function requestOf(c: Connection, positions?: Map<string, Position>): RouteRequest | null {
		const sourceNode = source.node(c.sourceNodeId);
		const targetNode = source.node(c.targetNodeId);
		if (!sourceNode || !targetNode) return null;
		const sourcePort = blockPortInfo(sourceNode, c.sourcePortIndex, true, positions?.get(sourceNode.id));
		const targetPort = blockPortInfo(targetNode, c.targetPortIndex, false, positions?.get(targetNode.id));
		if (!sourcePort || !targetPort) return null;
		return {
			id: c.id,
			netId: `${c.sourceNodeId}:${c.sourcePortIndex}`,
			source: sourcePort,
			target: targetPort,
			waypoints: (c.waypoints ?? []).filter((w) => w.isUserWaypoint)
		};
	}

	function requestsOf(connections: Iterable<Connection>, positions?: Map<string, Position>): RouteRequest[] {
		const requests: RouteRequest[] = [];
		for (const c of connections) {
			const request = requestOf(c, positions);
			if (request) requests.push(request);
		}
		return requests;
	}

	return {
		/** Compare the whole canvas with what the routing engine knows and send the differences */
		syncAll(): void {
			const nodes = source.blockNodes();
			const present = new Set(nodes.map((n) => n.id));
			const { changed, removed } = routingStore.diffNodes(
				nodes.map((n) => [n.id, sceneNodeOf(n)]),
				true
			);

			const connections = source
				.connections()
				.filter((c) => present.has(c.sourceNodeId) && present.has(c.targetNodeId));
			const next = new Map(connections.map((c) => [c.id, c]));
			const affected = new Map<string, Connection>();
			for (const c of connections) {
				if (routed.get(c.id) !== c) affected.set(c.id, c);
			}
			const removedRequests = [...routed.keys()].filter((id) => !next.has(id));
			routed = next;
			indexByNode(connections);
			collectAttached(
				changed.map(([id]) => id),
				affected
			);

			routingStore.send(
				{ nodes: changed, removedNodes: removed, requests: requestsOf(affected.values()), removedRequests },
				source.visibleBounds()
			);
		},

		/** Send nodes at (possibly dragged) positions together with their connections */
		syncNodes(ids: Iterable<string>, positions?: Map<string, Position>): void {
			const entries: [string, SceneNode][] = [];
			for (const id of ids) {
				const node = source.node(id);
				if (node?.type === 'pathview') entries.push([id, sceneNodeOf(node, positions?.get(id))]);
			}
			const { changed } = routingStore.diffNodes(entries, false);
			if (changed.length === 0) return;

			const affected = new Map<string, Connection>();
			collectAttached(
				changed.map(([id]) => id),
				affected
			);
			routingStore.send({
				nodes: changed,
				removedNodes: [],
				requests: requestsOf(affected.values(), positions),
				removedRequests: []
			});
		},

		/** Forget the scene, e.g. when navigating into a subsystem */
		reset(): void {
			routed = new Map();
			byNode = new Map();
			routingStore.reset();
		}
	};
}
