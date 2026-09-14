/**
 * Bus block definitions
 * Bus Creator and Bus Selector exist only in the editor; they are resolved
 * into direct wiring before code generation (see $lib/bus/expand).
 */

import { defineNode } from './defineNode';
import { nodeRegistry } from './registry';
import { BUS_CATEGORY, NODE_TYPES } from '$lib/constants/nodeTypes';

/** Bus Creator - bundles its input signals into one bus */
export const BusCreatorDefinition = defineNode({
	name: 'Bus Creator',
	category: BUS_CATEGORY,
	blockClass: NODE_TYPES.BUS_CREATOR,
	description:
		'Bundles its input signals into one bus. A signal is named after the label of its wire, or else the port it comes from.',
	inputs: ['in 0', 'in 1'],
	outputs: ['bus'],
	minInputs: 1,
	maxInputs: null,
	minOutputs: 1,
	maxOutputs: 1,
	shape: 'rect',
	params: {}
});

/** Bus Selector - picks signals out of a bus; its outputs follow the picked signals */
export const BusSelectorDefinition = defineNode({
	name: 'Bus Selector',
	category: BUS_CATEGORY,
	blockClass: NODE_TYPES.BUS_SELECTOR,
	description: 'Picks signals out of a bus by name, one output per picked signal.',
	inputs: ['bus'],
	outputs: [],
	minInputs: 1,
	maxInputs: 1,
	minOutputs: 0,
	maxOutputs: 0,
	shape: 'rect',
	params: {
		signals: { type: 'any', default: [], description: 'Signal paths picked from the bus, one output each' }
	}
});

export function registerBusNodes(): void {
	nodeRegistry.register(BusCreatorDefinition);
	nodeRegistry.register(BusSelectorDefinition);
}
