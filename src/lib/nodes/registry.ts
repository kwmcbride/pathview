/**
 * Node type registry
 * Manages all registered node types and provides lookup functionality
 */

import type { NodeTypeDefinition, NodeCategory, ParamDefinition, ParamType } from './types';
import { defineNode } from './defineNode';
import { extractedBlocks, blockConfig, type ExtractedBlock } from './generated/blocks';
import { acausalBlocks, acausalBlockConfig, type AcausalBlock } from './generated/acausal-blocks';
import { syncPortBlocks } from './uiConfig';
import { ACAUSAL_DOMAIN_COLORS } from '$lib/utils/colors';

const ACAUSAL_JUNCTION_TYPES: Record<string, string> = {
	electrical: 'ElectricalJunction',
	gas: 'GasJunction',
	gas_stream: 'GasStreamJunction'
};

class NodeRegistry {
	private nodes: Map<string, NodeTypeDefinition> = new Map();
	private byCategory: Map<NodeCategory, NodeTypeDefinition[]> = new Map();

	/**
	 * Register a new node type
	 */
	register(definition: NodeTypeDefinition): void {
		this.nodes.set(definition.type, definition);

		const categoryNodes = this.byCategory.get(definition.category) || [];
		categoryNodes.push(definition);
		this.byCategory.set(definition.category, categoryNodes);
	}

	/**
	 * Get a node type by its type ID
	 */
	get(type: string): NodeTypeDefinition | undefined {
		return this.nodes.get(type);
	}

	/**
	 * Get all node types in a category
	 */
	getByCategory(category: NodeCategory): NodeTypeDefinition[] {
		return this.byCategory.get(category) || [];
	}

	/**
	 * Get all registered categories
	 */
	getAllCategories(): NodeCategory[] {
		return Array.from(this.byCategory.keys());
	}

	/**
	 * Get all registered node types
	 */
	getAll(): NodeTypeDefinition[] {
		return Array.from(this.nodes.values());
	}

	/**
	 * Check if a node type is registered
	 */
	has(type: string): boolean {
		return this.nodes.has(type);
	}

	/**
	 * Get the count of registered nodes
	 */
	get size(): number {
		return this.nodes.size;
	}
}

// Export singleton instance
export const nodeRegistry = new NodeRegistry();

/**
 * Convert extracted block to node definition
 *
 * Port semantics from Block.info():
 * - null: Variable/unlimited ports (UI allows add/remove)
 * - []: No ports of this type
 * - ["in", "out"]: Fixed labeled ports (locked count)
 */
function createNodeFromExtracted(
	name: string,
	category: NodeCategory,
	extracted: ExtractedBlock
): void {
	// Build params from extracted data
	const params: Record<
		string,
		{
			type: ParamType;
			default: unknown;
			description?: string;
			min?: number;
			max?: number;
			options?: string[];
		}
	> = {};

	for (const [paramName, paramInfo] of Object.entries(extracted.params)) {
		params[paramName] = {
			type: paramInfo.type as ParamType,
			default: paramInfo.default,
			description: paramInfo.description,
			min: paramInfo.min,
			max: paramInfo.max,
			options: paramInfo.options
		};
	}

	// Determine inputs from extracted data
	let inputs: string[] | undefined;
	let maxInputs: number | null;

	if (extracted.inputs === null) {
		// Variable ports - use default, UI will allow add/remove
		inputs = undefined; // defineNode will use ['in 0']
		maxInputs = null; // unlimited
	} else if (extracted.inputs.length > 0) {
		// Fixed labeled ports
		inputs = extracted.inputs;
		maxInputs = extracted.inputs.length;
	} else {
		// Empty array means no inputs
		inputs = [];
		maxInputs = 0;
	}

	// Determine outputs from extracted data
	let outputs: string[] | undefined;
	let maxOutputs: number | null;

	if (extracted.outputs === null) {
		// Variable ports - use default, UI will allow add/remove
		outputs = undefined; // defineNode will use ['out 0']
		maxOutputs = null; // unlimited
	} else if (extracted.outputs.length > 0) {
		// Fixed labeled ports
		outputs = extracted.outputs;
		maxOutputs = extracted.outputs.length;
	} else {
		// Empty array means no outputs
		outputs = [];
		maxOutputs = 0;
	}

	const definition = defineNode({
		name,
		category,
		blockClass: extracted.blockClass,
		description: extracted.description,
		inputs,
		outputs,
		maxInputs,
		maxOutputs,
		syncPorts: syncPortBlocks.has(name),
		params
	});

	// Add docstringHtml from extracted data
	if (extracted.docstringHtml) {
		definition.docstring = extracted.docstringHtml;
	}

	nodeRegistry.register(definition);
}

/**
 * Initialize registry with all blocks from generated data
 */
function initializeRegistry(): void {
	for (const [category, blockNames] of Object.entries(blockConfig)) {
		for (const blockName of blockNames) {
			const extracted = extractedBlocks[blockName as keyof typeof extractedBlocks];

			if (extracted) {
				createNodeFromExtracted(blockName, category as NodeCategory, extracted);
			} else {
				console.warn(`Block "${blockName}" not found in extracted blocks`);
			}
		}
	}
}

/**
 * Convert an acausal block descriptor to a NodeTypeDefinition.
 *
 * Acausal nodes store all their ports in the `inputs` array with
 * direction: 'acausal'. The `outputs` array is always empty.
 * For variable-port components the port count is controlled by a
 * parameter (e.g. n_ports); the UI will add/remove ports as the
 * param changes (similar to Adder's operations param).
 */
function createAcausalNodeFromExtracted(
	name: string,
	category: NodeCategory,
	block: AcausalBlock
): void {
	const domainColor = ACAUSAL_DOMAIN_COLORS[block.domain] ?? ACAUSAL_DOMAIN_COLORS.default;

	// Build param definitions (reuse the same shape as causal params)
	const params: Record<
		string,
		{ type: ParamType; default: unknown; description?: string; min?: number; max?: number; options?: string[] }
	> = {};

	for (const [paramName, paramInfo] of Object.entries(block.params)) {
		params[paramName] = {
			type: paramInfo.type as ParamType,
			default: paramInfo.default,
			description: paramInfo.description
		};
	}

	// All ports are acausal — stored in the inputs array
	const isVariable = !!block.variablePorts;
	const fixedPortCount = block.ports.length;

	const definition = defineNode({
		name,
		category,
		blockClass: block.blockClass,
		description: block.description,
		// Acausal ports: listed as inputs with acausal direction marker names.
		// We use port names from the block definition.
		inputs: block.ports.map((p) => p.name),
		outputs: [],
		minInputs: isVariable ? 2 : fixedPortCount,
		maxInputs: isVariable ? null : fixedPortCount,
		minOutputs: 0,
		maxOutputs: 0,
		params
	});

	// Stamp domain color and acausal domain onto the definition
	definition.color = domainColor;
	definition.acausalDomain = block.domain;

	// Override port directions to 'acausal' and stamp domain color
	for (const port of definition.ports.inputs) {
		(port as { direction: string; color: string; domain: string }).direction = 'acausal';
		port.color = domainColor;
		port.domain = block.domain;
	}

	if (block.docstringHtml) {
		definition.docstring = block.docstringHtml;
	}

	nodeRegistry.register(definition);
}

/**
 * Initialize registry with all acausal components
 */
function initializeAcausalRegistry(): void {
	for (const [category, blockNames] of Object.entries(acausalBlockConfig)) {
		for (const blockName of blockNames) {
			const block = acausalBlocks[blockName as keyof typeof acausalBlocks];

			if (block) {
				createAcausalNodeFromExtracted(blockName, category as NodeCategory, block);
			} else {
				console.warn(`Acausal block "${blockName}" not found in acausal-blocks`);
			}
		}
	}
}

function registerAcausalJunctionNodes(): void {
	const junctionDefs: Array<{ domain: string; category: NodeCategory }> = [
		{ domain: 'electrical', category: 'Electrical' },
		{ domain: 'gas', category: 'Gas' },
		{ domain: 'gas_stream', category: 'GasStream' }
	];

	for (const { domain, category } of junctionDefs) {
		const type = ACAUSAL_JUNCTION_TYPES[domain];
		const domainColor = ACAUSAL_DOMAIN_COLORS[domain] ?? ACAUSAL_DOMAIN_COLORS.default;
		const definition = defineNode({
			name: 'Junction',
			category,
			blockClass: type,
			description: 'Editor-side acausal junction used to branch physical connections.',
			inputs: ['p1', 'p2', 'p3', 'p4'],
			outputs: [],
			minInputs: 4,
			maxInputs: 4,
			minOutputs: 0,
			maxOutputs: 0,
			shape: 'circle',
			params: {}
		});

		definition.color = domainColor;
		definition.acausalDomain = domain;

		for (const port of definition.ports.inputs) {
			(port as { direction: string; color: string; domain: string }).direction = 'acausal';
			port.color = domainColor;
			port.domain = domain;
		}

		nodeRegistry.register(definition);
	}
}

// Initialize on module load
initializeRegistry();
initializeAcausalRegistry();
registerAcausalJunctionNodes();

/**
 * Returns true if a node type is an acausal physical component.
 */
export function isAcausalNodeType(type: string): boolean {
	const def = nodeRegistry.get(type);
	return !!def?.acausalDomain;
}

export function isAcausalJunctionNodeType(type: string): boolean {
	return Object.values(ACAUSAL_JUNCTION_TYPES).includes(type);
}

export function getAcausalJunctionType(domain: string): string | null {
	return ACAUSAL_JUNCTION_TYPES[domain] ?? null;
}
