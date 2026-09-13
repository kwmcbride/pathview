import { describe, it, expect } from 'vitest';
import type { Position } from '$lib/types/common';
import type { RouteResult } from './types';
import { generateScenario, buildScene, sceneNode, sceneRequest, type ScenarioOptions } from './testing/scenario';
import { checkRoutes, measureRoutes } from './testing/invariants';
import { RoutingEngine, routeScene } from './engine';
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

function passesThrough(route: RouteResult, point: Position): boolean {
	const path = route.path;
	for (let i = 0; i < path.length - 1; i++) {
		const a = path[i];
		const b = path[i + 1];
		const onX = point.x >= Math.min(a.x, b.x) && point.x <= Math.max(a.x, b.x);
		const onY = point.y >= Math.min(a.y, b.y) && point.y <= Math.max(a.y, b.y);
		if (onX && onY) return true;
	}
	return false;
}

describe('routing engine', () => {
	const cases: { name: string; options: ScenarioOptions }[] = [
		{ name: 'plain', options: { connections: 150, seed: 3 } },
		{ name: 'rotated', options: { connections: 300, rotated: 0.5, seed: 4 } },
		{ name: 'dense', options: { connections: 400, rotated: 0.3, fanOut: 0.3, feedback: 0.2, gap: 4, seed: 11 } }
	];

	it.each(cases)('satisfies the routing invariants ($name)', ({ options }) => {
		const scene = buildScene(generateScenario(options));
		const routes = routeScene(scene);
		expect(checkRoutes(scene, routes)).toEqual([]);
		expect(routes.size).toBe(scene.requests.length);
	});

	it('separates overlapping nets into lanes', () => {
		const scene = buildScene(generateScenario({ connections: 400, rotated: 0.2, fanOut: 0.2, seed: 21 }));
		const raw = measureRoutes(scene, routeScene(scene, { congestion: false, nudge: false, negotiate: 0 }));
		const nudged = measureRoutes(scene, routeScene(scene));
		expect(raw.overlapLength).toBeGreaterThan(0);
		expect(nudged.overlapLength).toBeLessThan(raw.overlapLength * 0.5);
	});

	it('does not depend on connection order', () => {
		const scene = buildScene(generateScenario({ connections: 300, rotated: 0.3, fanOut: 0.2, seed: 13 }));
		const forward = routeScene(scene);
		const backward = routeScene({ ...scene, requests: [...scene.requests].reverse() });
		for (const [id, route] of forward) {
			expect(backward.get(id)!.path).toEqual(route.path);
		}
	});

	it('routes through user waypoints', () => {
		const scene = buildScene(generateScenario({ connections: 20, seed: 5 }));
		const request = scene.requests[0];
		const position = {
			x: Math.round((request.source.position.x + request.target.position.x) / 2 / GRID_SIZE) * GRID_SIZE,
			y: -400
		};
		request.waypoints = [{ id: 'w1', position, isUserWaypoint: true }];

		const routes = routeScene(scene);
		expect(passesThrough(routes.get(request.id)!, position)).toBe(true);
		expect(checkRoutes(scene, routes)).toEqual([]);
	});

	it('stays valid after incremental node moves', () => {
		const scenario = generateScenario({ connections: 300, rotated: 0.3, seed: 8 });
		const nodesById = new Map(scenario.nodes.map((n) => [n.id, n]));
		const engine = new RoutingEngine();
		for (const node of scenario.nodes) {
			const s = sceneNode(node);
			engine.setNode(node.id, s.bounds, s.ports);
		}
		for (const c of scenario.connections) engine.setRequest(sceneRequest(c, nodesById));
		engine.update();

		for (const id of ['n3', 'n10', 'n17', 'n25', 'n31']) {
			const node = nodesById.get(id)!;
			node.center = { x: node.center.x + 40, y: node.center.y + 20 };
			const s = sceneNode(node);
			engine.setNode(id, s.bounds, s.ports);
			for (const c of scenario.connections) {
				if (c.sourceNodeId === id || c.targetNodeId === id) engine.setRequest(sceneRequest(c, nodesById));
			}
			engine.update();
		}

		expect(checkRoutes(buildScene(scenario), engine.getRoutes())).toEqual([]);
	});

	it('reports only changes', () => {
		const scene = buildScene(generateScenario({ connections: 50, seed: 6 }));
		const engine = new RoutingEngine();
		for (const [id, node] of scene.nodes) engine.setNode(id, node.bounds, node.ports);
		for (const request of scene.requests) engine.setRequest(request);

		expect(engine.update().changed.size).toBe(50);
		expect(engine.update().changed.size).toBe(0);

		for (const request of scene.requests) engine.setRequest(request);
		expect(engine.update().changed.size).toBe(0);

		engine.removeRequest(scene.requests[0].id);
		const update = engine.update();
		expect(update.removed).toEqual([scene.requests[0].id]);
		expect(engine.getRoute(scene.requests[0].id)).toBeUndefined();
	});
});
