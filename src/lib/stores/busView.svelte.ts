/**
 * Bus view - bus facts of the current graph level, for rendering
 *
 * Computed centrally whenever the canvas rebuilds its edges, so a wire or bus
 * block only re-renders when its own entry changes. Bus structure follows wires
 * across all levels, so the whole model is analyzed.
 */

import { SvelteMap } from 'svelte/reactivity';
import type { Connection, NodeInstance } from '$lib/nodes/types';
import { NODE_TYPES } from '$lib/constants/nodeTypes';
import { analyzeBuses, containsBusBlocks, signalLeaves } from '$lib/bus/expand';

/** Connection ID to the number of signals the wire carries; absent for plain wires */
export const busWireSignals = new SvelteMap<string, number>();

/** Bus Creator ID to the signal name of each of its inputs */
export const busCreatorSignals = new SvelteMap<string, string[]>();

/** Node ID to the indices of its ports that carry a bus; absent when none does */
export const busPorts = new SvelteMap<string, { inputs: number[]; outputs: number[] }>();

function sync<T>(target: SvelteMap<string, T>, next: Map<string, T>, same: (a: T, b: T) => boolean): void {
	for (const key of [...target.keys()]) {
		if (!next.has(key)) target.delete(key);
	}
	for (const [key, value] of next) {
		const current = target.get(key);
		if (current === undefined || !same(current, value)) target.set(key, value);
	}
}

const sameNames = (a: string[], b: string[]) => a.length === b.length && a.every((name, i) => name === b[i]);
const sameIndices = (a: number[], b: number[]) => a.length === b.length && a.every((index, i) => index === b[i]);

/**
 * Recompute the bus view for the connections of the graph level at `path`
 * @param model - Root nodes and connections of the whole model
 */
export function updateBusView(
	model: { nodes: NodeInstance[]; connections: Connection[] },
	path: string[],
	connections: Connection[]
): void {
	const wires = new Map<string, number>();
	const creators = new Map<string, string[]>();
	const ports = new Map<string, { inputs: number[]; outputs: number[] }>();

	if (containsBusBlocks(model.nodes)) {
		const analysis = analyzeBuses(model.nodes, model.connections);
		const level = analysis.levelAt(path);
		if (level) {
			for (const connection of connections) {
				const structure = analysis.structureOut(level, connection.sourceNodeId, connection.sourcePortIndex);
				if (structure) wires.set(connection.id, signalLeaves(structure).length);
			}
			for (const node of level.nodeList) {
				if (node.type === NODE_TYPES.BUS_CREATOR) creators.set(node.id, analysis.elementNames(level, node));
				const inputs = node.inputs.flatMap((_, i) => (analysis.structureIn(level, node.id, i) ? [i] : []));
				const outputs = node.outputs.flatMap((_, i) => (analysis.structureOut(level, node.id, i) ? [i] : []));
				if (inputs.length > 0 || outputs.length > 0) ports.set(node.id, { inputs, outputs });
			}
		}
	}

	sync(busWireSignals, wires, (a, b) => a === b);
	sync(busCreatorSignals, creators, sameNames);
	sync(busPorts, ports, (a, b) => sameIndices(a.inputs, b.inputs) && sameIndices(a.outputs, b.outputs));
}
