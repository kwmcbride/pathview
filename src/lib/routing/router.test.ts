import { describe, it, expect } from 'vitest';
import { generateScenario } from './testing/scenario';
import { GRID_SIZE } from './constants';

describe('scenario generator', () => {
	it('is deterministic for a seed', () => {
		const a = generateScenario({ connections: 200, rotated: 0.3, seed: 5 });
		const b = generateScenario({ connections: 200, rotated: 0.3, seed: 5 });
		expect(a).toEqual(b);
	});

	it('generates the requested connections without fan-in', () => {
		const scenario = generateScenario({ connections: 500, seed: 2 });
		expect(scenario.connections.length).toBe(500);
		const targets = new Set(scenario.connections.map((c) => `${c.targetNodeId}:${c.targetPortIndex}`));
		expect(targets.size).toBe(scenario.connections.length);
	});

	it('keeps nodes on the grid', () => {
		const scenario = generateScenario({ connections: 300, rotated: 0.5, seed: 9 });
		for (const node of scenario.nodes) {
			for (const v of [node.center.x, node.center.y, node.width, node.height]) {
				expect(v % GRID_SIZE).toBe(0);
			}
		}
	});
});
