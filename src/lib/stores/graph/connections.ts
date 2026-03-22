/**
 * Graph store - Connection operations
 */

import { get } from 'svelte/store';
import type { Connection, NodeInstance, Waypoint } from '$lib/types/nodes';
import type { Position } from '$lib/types';
import {
	rootNodes,
	rootConnections,
	generateId,
	getCurrentGraph,
	updateCurrentConnections,
	updateCurrentNodesAndConnections
} from './state';
import { isAcausalJunctionNodeType, nodeRegistry } from '$lib/nodes/registry';
import { createPorts } from './helpers';

type JunctionSide = 'left' | 'right' | 'top' | 'bottom';

const JUNCTION_SIDE_VECTORS: Record<JunctionSide, { x: number; y: number }> = {
	left: { x: -1, y: 0 },
	right: { x: 1, y: 0 },
	top: { x: 0, y: -1 },
	bottom: { x: 0, y: 1 }
};

function isAcausalPortOccupied(
	connections: Connection[],
	nodeId: string,
	portIndex: number
): boolean {
	return connections.some(
		(c) =>
			c.kind === 'acausal' &&
			(
				(c.sourceNodeId === nodeId && c.sourcePortIndex === portIndex) ||
				(c.targetNodeId === nodeId && c.targetPortIndex === portIndex)
			)
	);
}

function getAcausalEndpointKey(nodeId: string, portIndex: number): string {
	return `${nodeId}:${portIndex}`;
}

function areAcausalPortsAlreadyConnected(
	connections: Connection[],
	sourceNodeId: string,
	sourcePortIndex: number,
	targetNodeId: string,
	targetPortIndex: number
): boolean {
	const sourceKey = getAcausalEndpointKey(sourceNodeId, sourcePortIndex);
	const targetKey = getAcausalEndpointKey(targetNodeId, targetPortIndex);
	if (sourceKey === targetKey) return true;

	const adjacency = new Map<string, Set<string>>();

	function connect(a: string, b: string): void {
		let neighbors = adjacency.get(a);
		if (!neighbors) {
			neighbors = new Set<string>();
			adjacency.set(a, neighbors);
		}
		neighbors.add(b);
	}

	for (const connection of connections) {
		if (connection.kind !== 'acausal') continue;
		const a = getAcausalEndpointKey(connection.sourceNodeId, connection.sourcePortIndex);
		const b = getAcausalEndpointKey(connection.targetNodeId, connection.targetPortIndex);
		connect(a, b);
		connect(b, a);
	}

	const pending = [sourceKey];
	const visited = new Set<string>(pending);

	while (pending.length > 0) {
		const current = pending.pop()!;
		if (current === targetKey) return true;
		for (const neighbor of adjacency.get(current) ?? []) {
			if (visited.has(neighbor)) continue;
			visited.add(neighbor);
			pending.push(neighbor);
		}
	}

	return false;
}

function isConnectionAttachedToNode(connection: Connection, nodeId: string): boolean {
	return connection.sourceNodeId === nodeId || connection.targetNodeId === nodeId;
}

function getOtherEndpoint(connection: Connection, junctionNodeId: string) {
	return connection.sourceNodeId === junctionNodeId
		? { nodeId: connection.targetNodeId, portIndex: connection.targetPortIndex }
		: { nodeId: connection.sourceNodeId, portIndex: connection.sourcePortIndex };
}

function removeJunctionNode(
	nodes: Map<string, NodeInstance>,
	nodeId: string
): Map<string, NodeInstance> {
	const next = new Map(nodes);
	next.delete(nodeId);
	return next;
}

function getJunctionPortSides(rotation: number): JunctionSide[] {
	switch (rotation) {
		case 1:
			return ['top', 'bottom', 'right', 'left'];
		case 2:
			return ['right', 'left', 'bottom', 'top'];
		case 3:
			return ['bottom', 'top', 'left', 'right'];
		default:
			return ['left', 'right', 'top', 'bottom'];
	}
}

function getJunctionConnectionPortIndex(connection: Connection, junctionNodeId: string): number {
	return connection.sourceNodeId === junctionNodeId
		? connection.sourcePortIndex
		: connection.targetPortIndex;
}

function getPreferredJunctionSide(dx: number, dy: number): JunctionSide {
	if (Math.abs(dx) >= Math.abs(dy)) {
		return dx >= 0 ? 'right' : 'left';
	}
	return dy >= 0 ? 'bottom' : 'top';
}

function getJunctionSideScore(
	side: JunctionSide,
	dx: number,
	dy: number,
	currentSide: JunctionSide
): number {
	const magnitude = Math.hypot(dx, dy);
	const vector = JUNCTION_SIDE_VECTORS[side];
	const alignment =
		magnitude > 1e-9 ? (dx / magnitude) * vector.x + (dy / magnitude) * vector.y : 0;
	const preferredSide = getPreferredJunctionSide(dx, dy);
	const preferredBonus = preferredSide === side ? 0.15 : 0;
	const stabilityBonus = currentSide === side ? 0.05 : 0;
	return alignment + preferredBonus + stabilityBonus;
}

function optimizeSingleJunctionPorts(
	nodes: Map<string, NodeInstance>,
	connections: Connection[],
	junctionNodeId: string
): Connection[] {
	const junctionNode = nodes.get(junctionNodeId);
	if (!junctionNode || !isAcausalJunctionNodeType(junctionNode.type)) return connections;

	const incidentConnections = connections
		.filter((connection) => connection.kind === 'acausal' && isConnectionAttachedToNode(connection, junctionNodeId))
		.slice()
		.sort((a, b) => a.id.localeCompare(b.id));

	if (incidentConnections.length === 0 || incidentConnections.length > junctionNode.inputs.length) {
		return connections;
	}

	const rotation = (junctionNode.params?.['_rotation'] as number) || 0;
	const portSides = getJunctionPortSides(rotation);
	const candidates = incidentConnections.map((connection) => {
		const otherEndpoint = getOtherEndpoint(connection, junctionNodeId);
		const otherNode = nodes.get(otherEndpoint.nodeId);
		const dx = (otherNode?.position.x ?? junctionNode.position.x) - junctionNode.position.x;
		const dy = (otherNode?.position.y ?? junctionNode.position.y) - junctionNode.position.y;
		const currentPortIndex = getJunctionConnectionPortIndex(connection, junctionNodeId);
		return { connection, dx, dy, currentPortIndex };
	});

	let bestScore = Number.NEGATIVE_INFINITY;
	let bestPortIndexes = candidates.map((candidate) => candidate.currentPortIndex);
	const used = new Set<number>();
	const assigned: number[] = new Array(candidates.length);

	function search(index: number, score: number): void {
		if (index === candidates.length) {
			if (score > bestScore) {
				bestScore = score;
				bestPortIndexes = [...assigned];
			}
			return;
		}

		const candidate = candidates[index];
		for (let portIndex = 0; portIndex < portSides.length; portIndex += 1) {
			if (used.has(portIndex)) continue;
			used.add(portIndex);
			assigned[index] = portIndex;
			search(
				index + 1,
				score +
					getJunctionSideScore(
						portSides[portIndex],
						candidate.dx,
						candidate.dy,
						portSides[candidate.currentPortIndex]
					)
			);
			used.delete(portIndex);
		}
	}

	search(0, 0);

	const bestPortByConnectionId = new Map<string, number>();
	let hasChanges = false;
	for (let index = 0; index < candidates.length; index += 1) {
		const candidate = candidates[index];
		const bestPortIndex = bestPortIndexes[index];
		bestPortByConnectionId.set(candidate.connection.id, bestPortIndex);
		if (bestPortIndex !== candidate.currentPortIndex) {
			hasChanges = true;
		}
	}

	if (!hasChanges) return connections;

	return connections.map((connection) => {
		const bestPortIndex = bestPortByConnectionId.get(connection.id);
		if (bestPortIndex === undefined) return connection;

		if (connection.sourceNodeId === junctionNodeId && connection.sourcePortIndex !== bestPortIndex) {
			return { ...connection, sourcePortIndex: bestPortIndex };
		}
		if (connection.targetNodeId === junctionNodeId && connection.targetPortIndex !== bestPortIndex) {
			return { ...connection, targetPortIndex: bestPortIndex };
		}
		return connection;
	});
}

export function optimizeJunctionPortsInConnections(
	nodes: Map<string, NodeInstance>,
	connections: Connection[],
	candidateJunctionIds?: Iterable<string>
): Connection[] {
	let nextConnections = connections;
	const junctionIds = candidateJunctionIds
		? [...candidateJunctionIds]
		: [...nodes.values()]
				.filter((node) => isAcausalJunctionNodeType(node.type))
				.map((node) => node.id);

	for (const junctionNodeId of junctionIds) {
		nextConnections = optimizeSingleJunctionPorts(nodes, nextConnections, junctionNodeId);
	}

	return nextConnections;
}

export function optimizeJunctionPorts(junctionNodeId: string): void {
	const currentGraph = getCurrentGraph();
	const optimizedConnections = optimizeJunctionPortsInConnections(
		currentGraph.nodes,
		currentGraph.connections,
		[junctionNodeId]
	);
	if (optimizedConnections !== currentGraph.connections) {
		updateCurrentConnections(() => optimizedConnections);
	}
}

export function optimizeAllJunctionPorts(): void {
	const currentGraph = getCurrentGraph();
	const optimizedConnections = optimizeJunctionPortsInConnections(
		currentGraph.nodes,
		currentGraph.connections
	);
	if (optimizedConnections !== currentGraph.connections) {
		updateCurrentConnections(() => optimizedConnections);
	}
}

export function collapseTrivialAcausalJunctions(
	nodes: Map<string, NodeInstance>,
	connections: Connection[],
	candidateJunctionIds?: Iterable<string>
): { nodes: Map<string, NodeInstance>; connections: Connection[]; collapsedJunctionIds: Set<string> } {
	let nextNodes = new Map(nodes);
	let nextConnections = [...connections];
	const collapsedJunctionIds = new Set<string>();
	const queuedJunctionIds = new Set<string>();
	const pendingJunctionIds: string[] = [];

	function enqueueJunction(nodeId: string): void {
		if (collapsedJunctionIds.has(nodeId) || queuedJunctionIds.has(nodeId)) return;
		const node = nextNodes.get(nodeId);
		if (!node || !isAcausalJunctionNodeType(node.type)) return;
		queuedJunctionIds.add(nodeId);
		pendingJunctionIds.push(nodeId);
	}

	if (candidateJunctionIds) {
		for (const nodeId of candidateJunctionIds) {
			enqueueJunction(nodeId);
		}
	} else {
		for (const node of nextNodes.values()) {
			if (isAcausalJunctionNodeType(node.type)) {
				enqueueJunction(node.id);
			}
		}
	}

	while (pendingJunctionIds.length > 0) {
		const junctionNodeId = pendingJunctionIds.shift()!;
		queuedJunctionIds.delete(junctionNodeId);
		const junctionNode = nextNodes.get(junctionNodeId);
		if (!junctionNode || !isAcausalJunctionNodeType(junctionNode.type)) continue;

		const remaining = nextConnections.filter((conn) => isConnectionAttachedToNode(conn, junctionNodeId));
		if (remaining.length > 2) continue;

		for (const connection of remaining) {
			const otherEndpoint = getOtherEndpoint(connection, junctionNodeId);
			enqueueJunction(otherEndpoint.nodeId);
		}

		nextConnections = nextConnections.filter((conn) => !isConnectionAttachedToNode(conn, junctionNodeId));

		if (remaining.length === 2) {
			const first = getOtherEndpoint(remaining[0], junctionNodeId);
			const second = getOtherEndpoint(remaining[1], junctionNodeId);
			const duplicateExists = nextConnections.some(
				(conn) =>
					conn.kind === 'acausal' &&
					(
						(conn.sourceNodeId === first.nodeId &&
							conn.sourcePortIndex === first.portIndex &&
							conn.targetNodeId === second.nodeId &&
							conn.targetPortIndex === second.portIndex) ||
						(conn.sourceNodeId === second.nodeId &&
							conn.sourcePortIndex === second.portIndex &&
							conn.targetNodeId === first.nodeId &&
							conn.targetPortIndex === first.portIndex)
					)
			);

			if (!duplicateExists && !(first.nodeId === second.nodeId && first.portIndex === second.portIndex)) {
				nextConnections.push({
					id: generateId(),
					sourceNodeId: first.nodeId,
					sourcePortIndex: first.portIndex,
					targetNodeId: second.nodeId,
					targetPortIndex: second.portIndex,
					kind: 'acausal',
					domain: remaining[0].domain ?? remaining[1].domain
				});
				enqueueJunction(first.nodeId);
				enqueueJunction(second.nodeId);
			}
		}

		nextNodes = removeJunctionNode(nextNodes, junctionNodeId);
		collapsedJunctionIds.add(junctionNodeId);
	}

	return { nodes: nextNodes, connections: nextConnections, collapsedJunctionIds };
}

/**
 * Add a connection between two ports
 */
export function addConnection(
	sourceNodeId: string,
	sourcePortIndex: number,
	targetNodeId: string,
	targetPortIndex: number,
	kind: 'causal' | 'acausal' = 'causal'
): Connection | null {
	const currentGraph = getCurrentGraph();
	const sourceNode = currentGraph.nodes.get(sourceNodeId);
	const targetNode = currentGraph.nodes.get(targetNodeId);

	if (!sourceNode || !targetNode) {
		console.error('Invalid node IDs for connection');
		return null;
	}

	if (kind === 'acausal') {
		// Acausal: both port indices reference the inputs array
		if (sourcePortIndex >= sourceNode.inputs.length || targetPortIndex >= targetNode.inputs.length) {
			console.error('Invalid port indices for acausal connection');
			return null;
		}
		const connections = currentGraph.connections;
		if (
			areAcausalPortsAlreadyConnected(
				connections,
				sourceNodeId,
				sourcePortIndex,
				targetNodeId,
				targetPortIndex
			)
		) {
			console.warn('Acausal ports are already connected through the same net');
			return null;
		}
		if (
			isAcausalJunctionNodeType(sourceNode.type) &&
			isAcausalPortOccupied(connections, sourceNodeId, sourcePortIndex)
		) {
			console.warn('Junction source port already has a connection');
			return null;
		}
		if (
			isAcausalJunctionNodeType(targetNode.type) &&
			isAcausalPortOccupied(connections, targetNodeId, targetPortIndex)
		) {
			console.warn('Junction target port already has a connection');
			return null;
		}
	} else {
		if (sourcePortIndex >= sourceNode.outputs.length || targetPortIndex >= targetNode.inputs.length) {
			console.error('Invalid port indices for connection');
			return null;
		}

		// Check if target port already has a connection (causal only)
		const connections = currentGraph.connections;
		const portOccupied = connections.some(
			c => c.targetNodeId === targetNodeId && c.targetPortIndex === targetPortIndex
		);
		if (portOccupied) {
			console.warn('Target port already has a connection');
			return null;
		}
	}

	// For acausal connections, resolve the domain from the source node's type definition
	const acausalDomain =
		kind === 'acausal'
			? nodeRegistry.get(sourceNode.type)?.acausalDomain
			: undefined;

	const connection: Connection = {
		id: generateId(),
		sourceNodeId,
		sourcePortIndex,
		targetNodeId,
		targetPortIndex,
		...(kind === 'acausal' ? { kind, ...(acausalDomain ? { domain: acausalDomain } : {}) } : {})
	};

	updateCurrentConnections(c => [...c, connection]);

	return connection;
}

export function splitAcausalConnectionWithJunction(
	connectionId: string,
	junctionType: string,
	junctionPosition: Position,
	sourceJunctionPort: number,
	targetJunctionPort: number
): NodeInstance | null {
	const currentGraph = getCurrentGraph();
	const connection = currentGraph.connections.find(
		(conn) => conn.id === connectionId && conn.kind === 'acausal'
	);
	if (!connection) return null;

	const junctionTypeDef = nodeRegistry.get(junctionType);
	if (!junctionTypeDef) {
		console.error(`Unknown junction type: ${junctionType}`);
		return null;
	}

	const junctionNodeId = generateId();
	const junctionNode: NodeInstance = {
		id: junctionNodeId,
		type: junctionType,
		name: junctionTypeDef.name,
		color: junctionTypeDef.color,
		position: junctionPosition,
		inputs: createPorts(junctionNodeId, 'input', junctionTypeDef.ports.inputs),
		outputs: createPorts(junctionNodeId, 'output', junctionTypeDef.ports.outputs),
		params: {}
	};

	if (
		sourceJunctionPort < 0 ||
		targetJunctionPort < 0 ||
		sourceJunctionPort >= junctionNode.inputs.length ||
		targetJunctionPort >= junctionNode.inputs.length ||
		sourceJunctionPort === targetJunctionPort
	) {
		console.error('Invalid junction ports for acausal split');
		return null;
	}

	const domain = connection.domain ?? nodeRegistry.get(junctionType)?.acausalDomain;
	const replacementConnections: Connection[] = [
		{
			id: generateId(),
			sourceNodeId: connection.sourceNodeId,
			sourcePortIndex: connection.sourcePortIndex,
			targetNodeId: junctionNodeId,
			targetPortIndex: sourceJunctionPort,
			kind: 'acausal',
			...(domain ? { domain } : {})
		},
		{
			id: generateId(),
			sourceNodeId: junctionNodeId,
			sourcePortIndex: targetJunctionPort,
			targetNodeId: connection.targetNodeId,
			targetPortIndex: connection.targetPortIndex,
			kind: 'acausal',
			...(domain ? { domain } : {})
		}
	];

	updateCurrentNodesAndConnections(
		(nodes) => {
			const next = new Map(nodes);
			next.set(junctionNode.id, junctionNode);
			return next;
		},
		(nodes) => [...nodes, junctionNode],
		(connections) =>
			connections.flatMap((conn) =>
				conn.id === connectionId ? replacementConnections : [conn]
			)
	);

	return junctionNode;
}

/**
 * Remove a connection
 */
export function removeConnection(id: string): void {
	const currentGraph = getCurrentGraph();
	const removedConnection = currentGraph.connections.find((conn) => conn.id === id);
	if (!removedConnection) return;

	const candidateJunctionIds = [removedConnection.sourceNodeId, removedConnection.targetNodeId].filter((nodeId) => {
		const node = currentGraph.nodes.get(nodeId);
		return !!node && isAcausalJunctionNodeType(node.type);
	});

	if (candidateJunctionIds.length === 0) {
		updateCurrentConnections((connections) => connections.filter((conn) => conn.id !== id));
		return;
	}

	const collapsed = collapseTrivialAcausalJunctions(
		currentGraph.nodes,
		currentGraph.connections.filter((conn) => conn.id !== id),
		candidateJunctionIds
	);

	updateCurrentNodesAndConnections(
		() => collapsed.nodes,
		(nodes) => nodes.filter((node) => !collapsed.collapsedJunctionIds.has(node.id)),
		() => collapsed.connections
	);
}

/**
 * Get all connections recursively (for code generation)
 */
export function getAllConnections(): { connection: Connection; subsystemId?: string }[] {
	const all: { connection: Connection; subsystemId?: string }[] = [];

	// Root connections
	for (const conn of get(rootConnections)) {
		all.push({ connection: conn });
	}

	// Collect from subsystems
	const collectConnections = (nodes: Map<string, unknown> | unknown[], parentId?: string) => {
		const nodeList = nodes instanceof Map ? Array.from(nodes.values()) : nodes;
		for (const node of nodeList as { id: string; graph?: { connections: Connection[]; nodes: unknown[] } }[]) {
			if (node.graph) {
				for (const conn of node.graph.connections) {
					all.push({ connection: conn, subsystemId: node.id });
				}
				collectConnections(node.graph.nodes, node.id);
			}
		}
	};
	collectConnections(get(rootNodes));

	return all;
}

/**
 * Update waypoints for a connection
 */
export function updateConnectionWaypoints(id: string, waypoints: Waypoint[]): void {
	updateCurrentConnections((connections) =>
		connections.map((c) => (c.id === id ? { ...c, waypoints } : c))
	);
}
