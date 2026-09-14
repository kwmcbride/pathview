/**
 * Graph store - Bus block operations
 */

import type { NodeInstance } from '$lib/nodes/types';
import { NODE_TYPES } from '$lib/constants/nodeTypes';
import { selectedSignals } from '$lib/bus/expand';
import { queueRemoveConnection } from '$lib/pyodide/mutationQueue';
import { createPorts } from './helpers';
import { getCurrentGraph, updateCurrentNodesAndConnections } from './state';

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
