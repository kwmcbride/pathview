import { describe, expect, it } from 'vitest';
import type { Connection, NodeInstance } from '$lib/types/nodes';
import fixtures from '../../../tests/fixtures/bus_expansion.json';
import { renamedSignals, selectorUses } from './rename';

function load(name: string) {
	const scenario = fixtures.scenarios.find((s) => s.name === name)!;
	return {
		nodes: scenario.nodes as unknown as NodeInstance[],
		connections: scenario.connections as unknown as Connection[]
	};
}

const relabel = (connections: Connection[], id: string, label: string) =>
	connections.map((c) => (c.id === id ? { ...c, label } : c));

describe('bus signal renames', () => {
	it('finds a selector inside a subsystem and follows the rename', () => {
		const { nodes, connections } = load('bus into a subsystem');
		const source = { path: [], creatorId: 'C', input: 1 };
		const uses = selectorUses(nodes, connections, source);
		expect(uses).toEqual([{ path: ['Sub'], selectorId: 'Sel', output: 0, signal: 'b', segment: 0 }]);
		expect(renamedSignals(nodes, relabel(connections, 'c2', 'beta'), source, uses).map((u) => u.signal)).toEqual(['beta']);
	});

	it('renames a name inside a nested signal path', () => {
		const { nodes, connections } = load('nested buses and selecting a sub-bus');
		const source = { path: [], creatorId: 'C1', input: 1 };
		const uses = selectorUses(nodes, connections, source);
		expect(uses.map((u) => `${u.selectorId}:${u.output}:${u.signal}`)).toEqual(['S:0:inner.b']);
		expect(renamedSignals(nodes, relabel(connections, 'c2', 'beta'), source, uses).map((u) => u.signal)).toEqual([
			'inner.beta'
		]);
	});

	it('ignores signals bundled at other inputs', () => {
		const { nodes, connections } = load('flat creator and selector');
		expect(selectorUses(nodes, connections, { path: [], creatorId: 'C', input: 1 }).map((u) => u.output)).toEqual([0]);
		expect(selectorUses(nodes, connections, { path: [], creatorId: 'other', input: 0 })).toEqual([]);
	});
});
