import { describe, it, expect } from 'vitest';
import type { RoutingResponse } from './protocol';
import { RoutingClient } from './client';
import { generateScenario, buildScene } from './testing/scenario';

function settle(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('routing client (without worker)', () => {
	const scene = buildScene(generateScenario({ connections: 30, seed: 4 }));
	const nodes = [...scene.nodes];

	it('routes sent changes and merges changes queued while busy', async () => {
		const responses: RoutingResponse[] = [];
		const client = new RoutingClient((r) => responses.push(r));

		client.send({ nodes, removedNodes: [], requests: scene.requests.slice(0, 10), removedRequests: [] });
		client.send({ nodes: [], removedNodes: [], requests: scene.requests.slice(10, 20), removedRequests: [] });
		client.send({ nodes: [], removedNodes: [], requests: scene.requests.slice(20), removedRequests: [] });
		await settle();
		await settle();

		// First delta goes out immediately, the two queued ones are merged into one
		expect(responses.length).toBe(2);
		const routed = new Set(responses.flatMap((r) => r.changed.map(([id]) => id)));
		expect(routed.size).toBe(scene.requests.length);
		client.dispose();
	});

	it('drops responses from before a reset', async () => {
		const responses: RoutingResponse[] = [];
		const client = new RoutingClient((r) => responses.push(r));

		client.send({ nodes, removedNodes: [], requests: scene.requests, removedRequests: [] });
		client.reset();
		await settle();
		await settle();

		expect(responses.every((r) => r.changed.length === 0)).toBe(true);
		client.dispose();
	});

	it('reports removed connections', async () => {
		const responses: RoutingResponse[] = [];
		const client = new RoutingClient((r) => responses.push(r));

		client.send({ nodes, removedNodes: [], requests: scene.requests, removedRequests: [] });
		await settle();
		client.send({ nodes: [], removedNodes: [], requests: [], removedRequests: [scene.requests[0].id] });
		await settle();

		expect(responses[responses.length - 1].removed).toEqual([scene.requests[0].id]);
		client.dispose();
	});
});
