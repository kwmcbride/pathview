/**
 * Routing benchmark, run with `npm run bench:routing`
 */

import { describe, it } from 'vitest';
import type { RouteResult, RoutingScene } from './types';
import { generateScenario, buildScene } from './testing/scenario';
import { measureRoutes } from './testing/invariants';
import { routeSceneLegacy } from './testing/legacyRouter';

interface Benchmarked {
	route: (scene: RoutingScene) => Map<string, RouteResult>;
	sizes: number[];
}

const routers: Record<string, Benchmarked> = {
	// Pre-v2 baseline, larger sizes take minutes
	legacy: { route: routeSceneLegacy, sizes: [1000] }
};

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
			}, 30 * 60_000);
		}
	}
});
