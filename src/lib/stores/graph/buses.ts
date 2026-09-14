/**
 * Graph store - Bus block operations
 */

import type { NodeInstance } from '$lib/nodes/types';
import { NODE_TYPES } from '$lib/constants/nodeTypes';
import { selectedSignals } from '$lib/bus/expand';
import { queueRemoveConnection } from '$lib/pyodide/mutationQueue';
import { createPorts } from './helpers';
import {
	getCurrentGraph,
	rootNodes,
	updateCurrentNodes,
	updateCurrentNodesAndConnections,
	updateSubsystemGraph
} from './state';

/**
 * Set the picked signals of Bus Selector outputs anywhere in the model, e.g. to
 * follow a renamed signal. Outputs are named after their signal and keep their wires.
 */
export function setSelectorSignalsAt(
	changes: { path: string[]; selectorId: string; output: number; signal: string }[]
): void {
	const byLevel = new Map<string, typeof changes>();
	for (const change of changes) {
		const key = change.path.join('/');
		byLevel.set(key, [...(byLevel.get(key) ?? []), change]);
	}

	for (const group of byLevel.values()) {
		const update = (node: NodeInstance): NodeInstance => {
			const own = group.filter((c) => c.selectorId === node.id);
			if (own.length === 0) return node;
			const signals = [...selectedSignals(node)];
			const outputs = [...node.outputs];
			for (const change of own) {
				signals[change.output] = change.signal;
				if (outputs[change.output]) outputs[change.output] = { ...outputs[change.output], name: change.signal };
			}
			return { ...node, params: { ...node.params, signals }, outputs };
		};

		const path = group[0].path;
		if (path.length === 0) {
			rootNodes.update((nodes) => new Map([...nodes].map(([id, node]) => [id, update(node)])));
		} else {
			updateSubsystemGraph(path, (graph) => ({ ...graph, nodes: graph.nodes.map(update) }));
		}
	}
}

/**
 * Set the signal one Bus Selector output picks. The output keeps its wires.
 * A signal another output already picks is ignored.
 */
export function setSelectorSignal(nodeId: string, index: number, signal: string): void {
	const node = getCurrentGraph().nodes.get(nodeId);
	if (!node || node.type !== NODE_TYPES.BUS_SELECTOR) return;
	const signals = selectedSignals(node);
	const path = signal.trim();
	if (!path || index >= signals.length || signals[index] === path || signals.includes(path)) return;

	const next = signals.map((s, i) => (i === index ? path : s));
	const update = (n: NodeInstance): NodeInstance =>
		n.id === nodeId
			? {
					...n,
					params: { ...n.params, signals: next },
					outputs: n.outputs.map((port, i) => (i === index ? { ...port, name: path } : port))
				}
			: n;

	updateCurrentNodes(
		(nodes) => {
			const current = nodes.get(nodeId);
			if (!current) return nodes;
			const updated = new Map(nodes);
			updated.set(nodeId, update(current));
			return updated;
		},
		(nodes) => nodes.map(update)
	);
}

/**
 * Set the signals a Bus Selector picks. Its outputs follow the list, one per
 * signal and named after it. Wires stay on their signal when the list changes;
 * wires of signals no longer picked are removed.
 */
export function setSelectedSignals(nodeId: string, signals: string[]): void {
	const graph = getCurrentGraph();
	const node = graph.nodes.get(nodeId);
	if (!node || node.type !== NODE_TYPES.BUS_SELECTOR) return;

	const previous = selectedSignals(node);
	const nextIndex = new Map(signals.map((signal, i) => [signal, i]));
	const outputs = createPorts(nodeId, 'output', signals.map((name) => ({ name })));
	const update = (n: NodeInstance): NodeInstance =>
		n.id === nodeId ? { ...n, params: { ...n.params, signals }, outputs } : n;

	const connections = graph.connections.flatMap((c) => {
		if (c.sourceNodeId !== nodeId) return [c];
		const signal = previous[c.sourcePortIndex];
		const port = signal === undefined ? undefined : nextIndex.get(signal);
		if (port === undefined) {
			queueRemoveConnection(c.id);
			return [];
		}
		return port === c.sourcePortIndex ? [c] : [{ ...c, sourcePortIndex: port }];
	});

	updateCurrentNodesAndConnections(
		(nodes) => {
			const current = nodes.get(nodeId);
			if (!current) return nodes;
			const next = new Map(nodes);
			next.set(nodeId, update(current));
			return next;
		},
		(nodes) => nodes.map(update),
		() => connections
	);
}
