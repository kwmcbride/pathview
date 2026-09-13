/**
 * Routing client - runs the routing engine in a web worker
 *
 * Sends scene differences and receives changed routes. While the worker is
 * busy, further differences are merged, so it never works through a backlog.
 * Once changes settle, a negotiation pass refines overlapping routes. Without
 * worker support (tests) the engine runs on the calling thread.
 */

import type { RouteRequest, SceneNode } from './types';
import { applyDelta, type RoutingDelta, type RoutingResponse } from './protocol';
import { RoutingEngine } from './engine';

/** Time without changes before overlapping nets are negotiated (ms) */
const REFINE_DELAY = 300;

/** Negotiation iterations of a refinement pass */
const REFINE_ITERATIONS = 3;

export type RoutingChanges = Pick<RoutingDelta, 'nodes' | 'removedNodes' | 'requests' | 'removedRequests'>;

/** Differences waiting for the worker; later changes to the same id win */
class PendingDelta {
	reset = false;
	negotiate = 0;
	readonly nodes = new Map<string, SceneNode>();
	readonly removedNodes = new Set<string>();
	readonly requests = new Map<string, RouteRequest>();
	readonly removedRequests = new Set<string>();

	get hasChanges(): boolean {
		return (
			this.nodes.size > 0 || this.removedNodes.size > 0 || this.requests.size > 0 || this.removedRequests.size > 0
		);
	}

	get isEmpty(): boolean {
		return !this.reset && this.negotiate === 0 && !this.hasChanges;
	}

	merge(changes: RoutingChanges): void {
		for (const id of changes.removedNodes) {
			this.nodes.delete(id);
			this.removedNodes.add(id);
		}
		for (const [id, node] of changes.nodes) {
			this.removedNodes.delete(id);
			this.nodes.set(id, node);
		}
		for (const id of changes.removedRequests) {
			this.requests.delete(id);
			this.removedRequests.add(id);
		}
		for (const request of changes.requests) {
			this.removedRequests.delete(request.id);
			this.requests.set(request.id, request);
		}
	}

	clear(): void {
		this.negotiate = 0;
		this.nodes.clear();
		this.removedNodes.clear();
		this.requests.clear();
		this.removedRequests.clear();
	}

	take(epoch: number): RoutingDelta {
		const delta: RoutingDelta = {
			epoch,
			reset: this.reset,
			nodes: [...this.nodes],
			removedNodes: [...this.removedNodes],
			requests: [...this.requests.values()],
			removedRequests: [...this.removedRequests],
			negotiate: this.negotiate
		};
		this.reset = false;
		this.clear();
		return delta;
	}
}

export class RoutingClient {
	private worker: Worker | null = null;
	private local: RoutingEngine | null = null;
	private busy = false;
	private epoch = 0;
	private readonly pending = new PendingDelta();
	private refineTimer: ReturnType<typeof setTimeout> | null = null;
	private needsRefine = false;

	constructor(private readonly onRoutes: (response: RoutingResponse) => void) {}

	/** Queue scene changes; they are routed without negotiation for a fast response */
	send(changes: RoutingChanges): void {
		this.pending.merge(changes);
		if (!this.pending.hasChanges) return;
		this.needsRefine = true;
		this.cancelRefine();
		this.flush();
	}

	/** Drop the scene, e.g. when the canvas shows a different graph level */
	reset(): void {
		this.epoch++;
		this.pending.clear();
		this.pending.reset = true;
		this.needsRefine = false;
		this.cancelRefine();
		this.flush();
	}

	dispose(): void {
		this.cancelRefine();
		this.worker?.terminate();
		this.worker = null;
	}

	private flush(): void {
		if (this.busy || this.pending.isEmpty) return;
		const delta = this.pending.take(this.epoch);
		this.busy = true;

		const worker = this.ensureWorker();
		if (worker) {
			worker.postMessage(delta);
			return;
		}
		queueMicrotask(() => {
			if (delta.reset || !this.local) this.local = new RoutingEngine();
			this.receive(applyDelta(this.local, delta));
		});
	}

	private receive(response: RoutingResponse): void {
		this.busy = false;
		if (response.epoch === this.epoch) this.onRoutes(response);
		if (!this.pending.isEmpty) {
			this.flush();
		} else if (this.needsRefine) {
			this.scheduleRefine();
		}
	}

	private ensureWorker(): Worker | null {
		if (this.worker) return this.worker;
		if (typeof Worker === 'undefined') return null;
		this.worker = new Worker(new URL('./routing.worker.ts', import.meta.url), { type: 'module' });
		this.worker.onmessage = (event: MessageEvent<RoutingResponse>) => this.receive(event.data);
		return this.worker;
	}

	private scheduleRefine(): void {
		this.cancelRefine();
		this.refineTimer = setTimeout(() => {
			this.refineTimer = null;
			this.needsRefine = false;
			this.pending.negotiate = REFINE_ITERATIONS;
			this.flush();
		}, REFINE_DELAY);
	}

	private cancelRefine(): void {
		if (this.refineTimer !== null) clearTimeout(this.refineTimer);
		this.refineTimer = null;
	}
}
