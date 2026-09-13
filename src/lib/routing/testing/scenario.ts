/**
 * Synthetic routing scenarios for tests and benchmarks
 *
 * Deterministic (seeded) block diagrams on the canvas grid: rows and columns of
 * multi-port blocks with forward wiring, fan-out and feedback connections.
 */

import type { Position, RotationValue } from '$lib/types/common';
import type { PortInfo, PortStub, RouteRequest, RoutingScene, SceneNode } from '../types';
import { calculateNodeDimensions, snapTo2G } from '$lib/constants/dimensions';
import { G } from '$lib/constants/grid';
import { getPortInfo } from '../portGeometry';

export interface ScenarioNode {
	id: string;
	center: Position;
	width: number;
	height: number;
	rotation: RotationValue;
	inputs: number;
	outputs: number;
}

export interface ScenarioConnection {
	id: string;
	sourceNodeId: string;
	sourcePortIndex: number;
	targetNodeId: string;
	targetPortIndex: number;
}

export interface Scenario {
	nodes: ScenarioNode[];
	connections: ScenarioConnection[];
}

export interface ScenarioOptions {
	/** Number of connections to generate */
	connections: number;
	/** Input and output ports per block */
	portsPerSide?: number;
	/** Probability that an output fans out to one more target */
	fanOut?: number;
	/** Probability that a connection runs backwards (feedback) */
	feedback?: number;
	/** Probability that a block is rotated */
	rotated?: number;
	/** Empty grid cells between neighbouring blocks */
	gap?: number;
	seed?: number;
}

/** Mulberry32 PRNG, deterministic across runs and platforms */
function createRandom(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/**
 * Generate a block diagram with approximately `connections` connections.
 * Fewer are generated only if the blocks run out of free input ports.
 */
export function generateScenario(options: ScenarioOptions): Scenario {
	const {
		connections: targetCount,
		portsPerSide = 4,
		fanOut = 0.1,
		feedback = 0.05,
		rotated = 0,
		gap = 12,
		seed = 1
	} = options;

	const random = createRandom(seed);
	const randomInt = (min: number, max: number) => min + Math.floor(random() * (max - min + 1));

	const blockCount = Math.max(2, Math.ceil((targetCount * 1.3) / portsPerSide));
	const rows = Math.max(1, Math.round(Math.sqrt(blockCount / 2)));
	const columns = Math.ceil(blockCount / rows);

	// Pitch covers both orientations so rotated blocks never overlap
	const horizontal = calculateNodeDimensions('f0000', portsPerSide, portsPerSide, 0, 0, 'Function');
	const vertical = calculateNodeDimensions('f0000', portsPerSide, portsPerSide, 0, 1, 'Function');
	const extent = Math.max(horizontal.width, horizontal.height, vertical.width, vertical.height);
	const pitch = snapTo2G(extent + G.px(gap));

	const nodes: ScenarioNode[] = [];
	for (let i = 0; i < blockCount; i++) {
		const rotation: RotationValue = random() < rotated ? (randomInt(1, 3) as RotationValue) : 0;
		const size = rotation === 1 || rotation === 3 ? vertical : horizontal;
		nodes.push({
			id: `n${i}`,
			center: { x: Math.floor(i / rows) * pitch, y: (i % rows) * pitch },
			width: size.width,
			height: size.height,
			rotation,
			inputs: portsPerSide,
			outputs: portsPerSide
		});
	}

	const nextInput = new Array<number>(blockCount).fill(0);
	const connections: ScenarioConnection[] = [];

	const pickTarget = (source: number): number | null => {
		const column = Math.floor(source / rows);
		const row = source % rows;
		for (let attempt = 0; attempt < 8; attempt++) {
			const backwards = random() < feedback || column === columns - 1;
			const targetColumn = backwards ? column - randomInt(0, 3) : column + randomInt(1, 2);
			const targetRow = row + randomInt(-2, 2);
			if (targetColumn < 0 || targetColumn >= columns || targetRow < 0 || targetRow >= rows) continue;
			const target = targetColumn * rows + targetRow;
			if (target < blockCount && nextInput[target] < portsPerSide) return target;
		}
		return null;
	};

	const connect = (source: number, port: number): boolean => {
		const target = pickTarget(source);
		if (target === null) return false;
		connections.push({
			id: `c${connections.length}`,
			sourceNodeId: nodes[source].id,
			sourcePortIndex: port,
			targetNodeId: nodes[target].id,
			targetPortIndex: nextInput[target]++
		});
		return true;
	};

	outer: for (let source = 0; source < blockCount; source++) {
		for (let port = 0; port < portsPerSide; port++) {
			if (connections.length >= targetCount) break outer;
			if (connect(source, port) && random() < fanOut && connections.length < targetCount) {
				connect(source, port);
			}
		}
	}

	return { nodes, connections };
}

function portOf(node: ScenarioNode, index: number, isOutput: boolean): PortInfo {
	return getPortInfo(
		node.center,
		node.width,
		node.height,
		node.rotation,
		index,
		isOutput ? node.outputs : node.inputs,
		isOutput
	);
}

/** Routing input for one node */
export function sceneNode(node: ScenarioNode): SceneNode {
	const ports: PortStub[] = [];
	for (let i = 0; i < node.inputs; i++) ports.push(portOf(node, i, false));
	for (let i = 0; i < node.outputs; i++) ports.push(portOf(node, i, true));
	return {
		bounds: {
			x: node.center.x - node.width / 2,
			y: node.center.y - node.height / 2,
			width: node.width,
			height: node.height
		},
		ports
	};
}

/** Routing input for one connection */
export function sceneRequest(connection: ScenarioConnection, nodesById: Map<string, ScenarioNode>): RouteRequest {
	return {
		id: connection.id,
		netId: `${connection.sourceNodeId}:${connection.sourcePortIndex}`,
		source: portOf(nodesById.get(connection.sourceNodeId)!, connection.sourcePortIndex, true),
		target: portOf(nodesById.get(connection.targetNodeId)!, connection.targetPortIndex, false),
		waypoints: []
	};
}

/**
 * Build the routing input for a scenario
 */
export function buildScene(scenario: Scenario): RoutingScene {
	const nodesById = new Map(scenario.nodes.map((n) => [n.id, n]));
	return {
		nodes: new Map(scenario.nodes.map((n) => [n.id, sceneNode(n)])),
		requests: scenario.connections.map((c) => sceneRequest(c, nodesById))
	};
}
