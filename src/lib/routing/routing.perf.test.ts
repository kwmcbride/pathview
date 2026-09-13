/**
 * Routing benchmark, run with `npm run bench:routing`
 */

import { describe, it } from 'vitest';
import type { RouteResult, RoutingScene } from './types';
import { generateScenario, buildScene, sceneNode, sceneRequest } from './testing/scenario';
import { measureRoutes } from './testing/invariants';
import { routeSceneLegacy } from './testing/legacyRouter';
import { RoutingEngine, routeScene } from './engine';

interface Benchmarked {
	route: (scene: RoutingScene) => Map<string, RouteResult>;
	sizes: number[];
}

const routers: Record<string, Benchmarked> = {
	// Pre-v2 baseline, larger sizes take minutes
	legacy: { route: routeSceneLegacy, sizes: [1000] },
	engine: { route: (scene) => routeScene(scene), sizes: [1000, 5000, 10000] }
};

const TIMEOUT = 30 * 60_000;

describe.skipIf(import.meta.env.MODE !== 'perf')('routing performance', () => {
	for (const [name, { route, sizes }] of Object.entries(routers)) {
		for (const size of sizes) {
			it(`${name}: full routing of ${size} connections`, () => {
				const scene = buildScene(generateScenario({ connections: size, rotated: 0.1, seed: 7 }));
				const start = performance.now();
				const routes = route(scene);
				const ms = performance.now() - start;
				const metrics = measureRoutes(scene, routes);
				console.log(JSON.stringify({ router: name, connections: size, ms: Math.round(ms), ...metrics }));
			}, TIMEOUT);
		}
	}

	it('engine: incremental node drag in 10000 connections', () => {
		const scenario = generateScenario({ connections: 10000, rotated: 0.1, seed: 7 });
		const nodesById = new Map(scenario.nodes.map((n) => [n.id, n]));
		const engine = new RoutingEngine();
		for (const node of scenario.nodes) {
			const s = sceneNode(node);
			engine.setNode(node.id, s.bounds, s.ports);
		}
		for (const c of scenario.connections) engine.setRequest(sceneRequest(c, nodesById));
		engine.update();

		const node = scenario.nodes[Math.floor(scenario.nodes.length / 2)];
		const attached = scenario.connections.filter((c) => c.sourceNodeId === node.id || c.targetNodeId === node.id);
		const samples: number[] = [];
		for (let step = 0; step < 20; step++) {
			node.center = { x: node.center.x + 10, y: node.center.y };
			const start = performance.now();
			const s = sceneNode(node);
			engine.setNode(node.id, s.bounds, s.ports);
			for (const c of attached) engine.setRequest(sceneRequest(c, nodesById));
			engine.update();
			samples.push(performance.now() - start);
		}
		samples.sort((a, b) => a - b);
		console.log(
			JSON.stringify({
				router: 'engine',
				case: 'drag step',
				connections: scenario.connections.length,
				attached: attached.length,
				medianMs: Math.round(samples[10] * 10) / 10,
				maxMs: Math.round(samples[19] * 10) / 10
			})
		);
	}, TIMEOUT);
});
