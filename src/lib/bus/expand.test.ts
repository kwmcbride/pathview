import { describe, expect, it } from 'vitest';
import type { Connection, NodeInstance } from '$lib/types/nodes';
import fixtures from '../../../tests/fixtures/bus_expansion.json';
import { analyzeBuses, expandBuses, isBusBlock, signalLeaves } from './expand';

type Scenario = (typeof fixtures.scenarios)[number];

const wiring = (connections: Connection[]) =>
	connections.map((c) => `${c.sourceNodeId}:${c.sourcePortIndex}>${c.targetNodeId}:${c.targetPortIndex}`).sort();

/** Wiring per level, keyed by subsystem ID path */
function levels(nodes: NodeInstance[], connections: Connection[], path = ''): Record<string, string[]> {
	const result: Record<string, string[]> = { [path]: wiring(connections) };
	for (const node of nodes) {
		if (!node.graph) continue;
		Object.assign(result, levels(node.graph.nodes, node.graph.connections, path ? `${path}/${node.id}` : node.id));
	}
	return result;
}

function anyBusBlock(nodes: NodeInstance[]): boolean {
	return nodes.some((n) => isBusBlock(n) || (n.graph ? anyBusBlock(n.graph.nodes) : false));
}

function load(scenario: Scenario) {
	return {
		nodes: scenario.nodes as unknown as NodeInstance[],
		connections: scenario.connections as unknown as Connection[]
	};
}

describe('bus expansion', () => {
	for (const scenario of fixtures.scenarios) {
		it(scenario.name, () => {
			const { nodes, connections } = load(scenario);
			const expanded = expandBuses(nodes, connections);
			const expected = Object.fromEntries(
				Object.entries(scenario.expected as Record<string, string[]>).map(([key, value]) => [key, [...value].sort()])
			);
			expect(levels(expanded.nodes, expanded.connections)).toEqual(expected);
			expect(anyBusBlock(expanded.nodes)).toBe(false);
		});
	}

	it('returns a model without bus blocks as it is', () => {
		const { nodes, connections } = load(fixtures.scenarios.find((s) => s.name.includes('without buses'))!);
		const expanded = expandBuses(nodes, connections);
		expect(expanded.nodes).toBe(nodes);
		expect(expanded.connections).toBe(connections);
	});

	it('follows a bus structure into a subsystem', () => {
		const { nodes, connections } = load(fixtures.scenarios.find((s) => s.name === 'bus into a subsystem')!);
		const analysis = analyzeBuses(nodes, connections);
		const inner = analysis.levelAt(['Sub'])!;
		expect(signalLeaves(analysis.structureOut(inner, 'I', 0))).toEqual(['a', 'b']);
		expect(signalLeaves(analysis.structureIn(analysis.root, 'Scope', 0))).toEqual(['']);
	});
});
