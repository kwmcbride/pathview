/**
 * PathSim Runner
 * Converts graph state to Python code and runs simulations
 */

import type { NodeInstance, Connection, SimulationSettings } from '$lib/nodes/types';
import { DEFAULT_SIMULATION_SETTINGS } from '$lib/nodes/types';
import type { EventInstance } from '$lib/events/types';
import { nodeRegistry } from '$lib/nodes/registry';
import { eventRegistry } from '$lib/events/registry';
import { NODE_TYPES } from '$lib/constants/nodeTypes';
import { BLOCK_CATEGORY_ORDER } from '$lib/constants/python';
import { isSubsystem, isInterface } from '$lib/nodes/shapes';
import { blockImportPaths } from '$lib/nodes/generated/blocks';
import { acausalBlockImportPaths } from '$lib/nodes/generated/acausal-blocks';
import { isAcausalJunctionNodeType, isAcausalNodeType } from '$lib/nodes/registry';
import { graphStore, findParentSubsystem } from '$lib/stores/graph';
import {
	runStreamingSimulation,
	validateGraph as validateGraphBridge,
	type SimulationResult,
	type ValidationResult
} from './bridge';
import { getBackendType, switchBackend, init as initBackend, setFlaskHost } from './backend';
import {
	generateParamString,
	generateConnectionLines,
	generateListDefinition,
	sanitizeName
} from './codeBuilder';
import { generateAcausalStreamingStartCode } from './pythonHelpers';

// Re-export sanitizeName for external use
export { sanitizeName } from './codeBuilder';

/**
 * Get setting value or fall back to default
 */
function getSettingOrDefault<K extends keyof SimulationSettings>(
	settings: SimulationSettings,
	key: K
): SimulationSettings[K] {
	const value = settings[key];
	if (value === '' || value === null || value === undefined) {
		return DEFAULT_SIMULATION_SETTINGS[key];
	}
	return value;
}


/**
 * Generate block parameter string (skips internal params starting with _)
 */
function generateBlockParams(
	params: Record<string, unknown>,
	validParamNames: Set<string>,
	multiLine: boolean = false
): string {
	return generateParamString(params, validParamNames, {
		multiLine,
		skipInternal: true
	});
}

/**
 * Generate event parameter string
 */
function generateEventParams(
	params: Record<string, unknown>,
	validParamNames: Set<string>,
	multiLine: boolean = false
): string {
	return generateParamString(params, validParamNames, { multiLine });
}


/**
 * Generate event definitions and return event variable names
 */
function generateEventDefinitions(
	events: EventInstance[],
	existingVarNames: string[],
	lines: string[],
	multiLine: boolean = false
): string[] {
	const eventVarNames: string[] = [];

	for (const event of events) {
		const typeDef = eventRegistry.get(event.type);
		if (!typeDef) continue;

		let varName = sanitizeName(event.name);
		if (!varName || existingVarNames.includes(varName) || eventVarNames.includes(varName)) {
			varName = `event_${eventVarNames.length}`;
		}
		eventVarNames.push(varName);

		const validParamNames = new Set(typeDef.params.map(p => p.name));
		const params = generateEventParams(event.params, validParamNames, multiLine);

		if (params) {
			lines.push(`${varName} = ${typeDef.eventClass}(${params})`);
		} else {
			lines.push(`${varName} = ${typeDef.eventClass}()`);
		}
	}

	return eventVarNames;
}


/**
 * Generate the Simulation constructor
 */
function generateSimulationSetup(
	settings: SimulationSettings,
	hasEvents: boolean,
	lines: string[],
	indent: string = '    '
): void {
	lines.push('sim = Simulation(');
	lines.push(`${indent}blocks,`);
	lines.push(`${indent}connections,`);
	if (hasEvents) {
		lines.push(`${indent}events,`);
	}
	lines.push(`${indent}Solver=${getSettingOrDefault(settings, 'solver')},`);
	lines.push(`${indent}dt=${getSettingOrDefault(settings, 'dt')},`);
	lines.push(`${indent}dt_min=${getSettingOrDefault(settings, 'dt_min')},`);

	const dtMax = getSettingOrDefault(settings, 'dt_max');
	if (dtMax) {
		lines.push(`${indent}dt_max=${dtMax},`);
	}

	lines.push(`${indent}tolerance_lte_rel=${getSettingOrDefault(settings, 'rtol')},`);
	lines.push(`${indent}tolerance_lte_abs=${getSettingOrDefault(settings, 'atol')},`);
	lines.push(`${indent}tolerance_fpi=${getSettingOrDefault(settings, 'ftol')},`);
	lines.push(')');
}

/**
 * Recursively collect all nodes including those inside subsystems
 */
function getAllNodesRecursively(nodes: NodeInstance[]): NodeInstance[] {
	const allNodes: NodeInstance[] = [];
	for (const node of nodes) {
		allNodes.push(node);
		if (isSubsystem(node)) {
			allNodes.push(...getAllNodesRecursively(node.graph?.nodes ?? []));
		}
	}
	return allNodes;
}

/**
 * Collect block classes used across all nodes, grouped by Python import path.
 * Excludes Subsystem/Interface (imported from pathsim directly).
 */
function collectBlockImportGroups(nodes: NodeInstance[]): Map<string, Set<string>> {
	const allNodes = getAllNodesRecursively(nodes);
	const groups = new Map<string, Set<string>>();

	for (const node of allNodes) {
		if (isSubsystem(node) || isInterface(node)) continue;
		const typeDef = nodeRegistry.get(node.type);
		if (!typeDef) continue;

		const importPath = blockImportPaths[typeDef.blockClass] || 'pathsim.blocks';
		if (!groups.has(importPath)) groups.set(importPath, new Set());
		groups.get(importPath)!.add(typeDef.blockClass);
	}

	return groups;
}

/** Options for subsystem code generation */
interface SubsystemCodeOptions {
	/** Use multi-line formatting with keyword arguments (for export) */
	formatted?: boolean;
}

/**
 * Generate code for a subsystem and its contents
 * Returns the variable name for the subsystem
 */
function generateSubsystemCode(
	subsystemNode: NodeInstance,
	nodeVars: Map<string, string>,
	varNames: string[],
	lines: string[],
	prefix: string = '',
	options: SubsystemCodeOptions = {}
): string {
	const { formatted = false } = options;
	const childNodes = subsystemNode.graph?.nodes ?? [];
	const childConnections = subsystemNode.graph?.connections ?? [];
	const childEvents = subsystemNode.graph?.events ?? [];

	// Generate subsystem variable name
	let subsystemVarName = sanitizeName(subsystemNode.name);
	if (!subsystemVarName || varNames.includes(subsystemVarName)) {
		subsystemVarName = `subsystem_${varNames.length}`;
	}
	varNames.push(subsystemVarName);
	nodeVars.set(subsystemNode.id, subsystemVarName);

	const subPrefix = prefix + subsystemVarName + '_';

	// Find Interface block(s) inside this subsystem
	const interfaceNodes = childNodes.filter(isInterface);

	// Generate internal blocks (excluding Interface - it's handled separately)
	const internalBlocks = childNodes.filter((n) => !isInterface(n));
	const internalVarNames: string[] = [];
	const internalNodeVars = new Map<string, string>();

	// Add section comment for formatted output
	if (formatted) {
		lines.push('');
		lines.push(`# Subsystem: ${subsystemNode.name}`);
	}

	// First, generate Interface block
	for (const iface of interfaceNodes) {
		const ifaceVarName = subPrefix + 'interface';
		internalVarNames.push(ifaceVarName);
		internalNodeVars.set(iface.id, ifaceVarName);
		lines.push(`${ifaceVarName} = Interface()`);
	}

	// Generate internal blocks
	for (const node of internalBlocks) {
		// Check if this is a nested subsystem
		if (isSubsystem(node)) {
			// Recursively generate nested subsystem
			generateSubsystemCode(
				node,
				internalNodeVars,
				internalVarNames,
				lines,
				subPrefix,
				options
			);
		} else {
			const typeDef = nodeRegistry.get(node.type);
			if (!typeDef) continue;

			let varName = subPrefix + sanitizeName(node.name);
			if (!varName || internalVarNames.includes(varName)) {
				varName = `${subPrefix}block_${internalVarNames.length}`;
			}
			internalVarNames.push(varName);
			internalNodeVars.set(node.id, varName);

			const validParamNames = new Set(typeDef.params.map((p) => p.name));
			const params = generateBlockParams(node.params, validParamNames, formatted);

			if (params) {
				lines.push(`${varName} = ${typeDef.blockClass}(${params})`);
			} else {
				lines.push(`${varName} = ${typeDef.blockClass}()`);
			}
		}
	}

	// Propagate internal block IDs to parent nodeVars (for _node_id_map)
	for (const [nodeId, varName] of internalNodeVars) {
		nodeVars.set(nodeId, varName);
	}

	// Generate internal events (need to be defined before Subsystem constructor)
	const eventVarNames: string[] = [];
	if (childEvents.length > 0) {
		for (const event of childEvents) {
			const typeDef = eventRegistry.get(event.type);
			if (!typeDef) continue;

			let eventVarName = subPrefix + sanitizeName(event.name);
			if (!eventVarName || varNames.includes(eventVarName) || eventVarNames.includes(eventVarName)) {
				eventVarName = `${subPrefix}event_${eventVarNames.length}`;
			}
			eventVarNames.push(eventVarName);

			const validParamNames = new Set(typeDef.params.map(p => p.name));
			const params = generateEventParams(event.params, validParamNames, formatted);

			if (params) {
				lines.push(`${eventVarName} = ${typeDef.eventClass}(${params})`);
			} else {
				lines.push(`${eventVarName} = ${typeDef.eventClass}()`);
			}
		}
	}

	// Create Subsystem with inline blocks and connections using kwargs
	lines.push(`${subsystemVarName} = Subsystem(`);

	// Blocks list
	lines.push('    blocks=[');
	for (const varName of internalVarNames) {
		lines.push(`        ${varName},`);
	}
	lines.push('    ],');

	// Connections list (grouped by source for multi-target syntax)
	lines.push('    connections=[');
	const connLines = generateConnectionLines(childConnections, internalNodeVars, '        ');
	for (const line of connLines) {
		lines.push(line);
	}
	lines.push('    ],');

	// Events list (if any)
	if (childEvents.length > 0) {
		lines.push('    events=[');
		for (const eventVarName of eventVarNames) {
			lines.push(`        ${eventVarName},`);
		}
		lines.push('    ],');
	}

	lines.push(')');
	if (!formatted) {
		lines.push('');
	}

	return subsystemVarName;
}

/**
 * Group nodes by category
 */
function groupNodesByCategory(
	nodes: NodeInstance[]
): Map<string, { node: NodeInstance; typeDef: ReturnType<typeof nodeRegistry.get> }[]> {
	const groups = new Map<string, { node: NodeInstance; typeDef: ReturnType<typeof nodeRegistry.get> }[]>();

	for (const node of nodes) {
		const typeDef = nodeRegistry.get(node.type);
		if (!typeDef) continue;

		const category = typeDef.category || 'Other';
		if (!groups.has(category)) {
			groups.set(category, []);
		}
		groups.get(category)!.push({ node, typeDef });
	}

	return groups;
}

// ─────────────────────────────────────────────────────────────────────────────
// Acausal code generation
// ─────────────────────────────────────────────────────────────────────────────

type AcausalRuntimeMode = 'default' | 'pyodide-sympy';

const PYODIDE_SYMPY_ACAUSAL_COMPONENTS = new Set([
	'Resistor',
	'Capacitor',
	'Inductor',
	'VoltageSource',
	'CurrentSource',
	'Ground'
]);

function isCompiledAcausalNode(node: NodeInstance): boolean {
	return isAcausalNodeType(node.type) && !isAcausalJunctionNodeType(node.type);
}

/** Returns true when the top-level node list contains any acausal component. */
function hasAcausalNodes(nodes: NodeInstance[]): boolean {
	return nodes.some((n) => isCompiledAcausalNode(n));
}

function getAcausalNodes(nodes: NodeInstance[]): NodeInstance[] {
	return nodes.filter((n) => isCompiledAcausalNode(n));
}

/** Returns true when the graph has BOTH acausal nodes and non-interface causal nodes. */
function isMixedGraph(nodes: NodeInstance[]): boolean {
	const hasAcausal = nodes.some((n) => isCompiledAcausalNode(n));
	const hasCausal = nodes.some((n) => !isAcausalNodeType(n.type) && !isInterface(n));
	return hasAcausal && hasCausal;
}

function isPyodideSympyCompatibleAcausalNode(node: NodeInstance): boolean {
	const typeDef = nodeRegistry.get(node.type);
	return Boolean(
		typeDef?.acausalDomain === 'electrical' &&
			PYODIDE_SYMPY_ACAUSAL_COMPONENTS.has(node.type)
	);
}

function canRunAcausalInPyodide(nodes: NodeInstance[]): boolean {
	const acausalNodes = getAcausalNodes(nodes);
	return acausalNodes.length > 0 && acausalNodes.every(isPyodideSympyCompatibleAcausalNode);
}

function getUnsupportedPyodideAcausalTypes(nodes: NodeInstance[]): string[] {
	const unsupported = new Set<string>();
	for (const node of getAcausalNodes(nodes)) {
		if (!isPyodideSympyCompatibleAcausalNode(node)) {
			unsupported.add(node.type);
		}
	}
	return [...unsupported].sort();
}

function usesSympyAcausalRuntime(acausalRuntimeMode: AcausalRuntimeMode): boolean {
	return acausalRuntimeMode === 'pyodide-sympy';
}

function getAcausalImportLine(acausalRuntimeMode: AcausalRuntimeMode): string {
	return usesSympyAcausalRuntime(acausalRuntimeMode)
		? 'from pathsim.acausal import AcausalNetwork, SYMPY_ACAUSAL_BACKEND'
		: 'from pathsim.acausal import AcausalNetwork';
}

function getAcausalNetworkLine(acausalRuntimeMode: AcausalRuntimeMode): string {
	return usesSympyAcausalRuntime(acausalRuntimeMode)
		? 'net = AcausalNetwork(backend=SYMPY_ACAUSAL_BACKEND)'
		: 'net = AcausalNetwork()';
}

function addAcausalComponentBackend(
	params: string,
	acausalRuntimeMode: AcausalRuntimeMode
): string {
	if (!usesSympyAcausalRuntime(acausalRuntimeMode)) {
		return params;
	}
	return params ? `${params}, backend=SYMPY_ACAUSAL_BACKEND` : 'backend=SYMPY_ACAUSAL_BACKEND';
}

function addAcausalComponentName(params: string, nodeName: string): string {
	if (/\bname\s*=/.test(params)) {
		return params;
	}
	const escapedName = nodeName.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
	return params ? `${params}, name="${escapedName}"` : `name="${escapedName}"`;
}

function getUniqueAcausalComponentName(nodeName: string, usedNames: Set<string>): string {
	const baseName = nodeName.trim() || 'Component';
	if (!usedNames.has(baseName)) {
		usedNames.add(baseName);
		return baseName;
	}

	let suffix = 2;
	let candidate = `${baseName}${suffix}`;
	while (usedNames.has(candidate)) {
		suffix += 1;
		candidate = `${baseName}${suffix}`;
	}
	usedNames.add(candidate);
	return candidate;
}

function buildAcausalComponentParams(
	node: NodeInstance,
	validParamNames: Set<string>,
	acausalRuntimeMode: AcausalRuntimeMode,
	componentName: string
): string {
	const withName = addAcausalComponentName(
		generateBlockParams(node.params, validParamNames),
		componentName
	);
	return addAcausalComponentBackend(withName, acausalRuntimeMode);
}

function isFlaskBackendExplicitlyRequested(): boolean {
	if (typeof window === 'undefined') return false;
	return new URLSearchParams(window.location.search).get('backend') === 'flask';
}

async function probeFlaskHost(host: string): Promise<boolean> {
	try {
		const response = await fetch(`${host.replace(/\/$/, '')}/api/health`, {
			method: 'GET',
			credentials: 'omit',
			signal: AbortSignal.timeout(2000)
		});
		return response.ok;
	} catch {
		return false;
	}
}

function getCandidateFlaskHosts(): string[] {
	const hosts = new Set<string>();
	if (typeof window !== 'undefined') {
		hosts.add(window.location.origin);
		const { hostname, protocol } = window.location;
		hosts.add(`http://${hostname}:5000`);
		if (protocol === 'https:') {
			hosts.add(`https://${hostname}:5000`);
		}
	}
	hosts.add('http://localhost:5000');
	hosts.add('http://127.0.0.1:5000');
	return [...hosts];
}

async function findAvailableFlaskHost(): Promise<string | null> {
	for (const host of getCandidateFlaskHosts()) {
		if (await probeFlaskHost(host)) {
			return host.replace(/\/$/, '');
		}
	}
	return null;
}

/**
 * Resolve the port name for an acausal connection endpoint.
 * Acausal ports live in the node's `inputs` array (all direction: 'acausal').
 * sourcePortIndex / targetPortIndex are indices into that array.
 */
function resolveAcausalPortName(
	nodeId: string,
	portIndex: number,
	nodeMap: Map<string, NodeInstance>
): string | null {
	const node = nodeMap.get(nodeId);
	if (!node) return null;
	const runtimePort = node.inputs[portIndex];
	if (runtimePort?.name) return runtimePort.name;
	const typeDef = nodeRegistry.get(node.type);
	if (!typeDef) return null;
	const port = typeDef.ports.inputs[portIndex];
	return port?.name ?? null;
}

/**
 * Group acausal connections into net-junctions using union-find.
 *
 * PathSim's net.connect(A.p, B.n, C.ref) joins all listed ports into a
 * single node.  Calling net.connect(A.p, B.n) and then net.connect(B.n, C.ref)
 * creates TWO separate junctions.  We therefore compute connected components
 * across all acausal connections and emit one net.connect() per component.
 *
 * Returns a list of groups, each group being a list of "varName.portName" strings.
 */
function buildAcausalConnectGroups(
	acausalConns: Connection[],
	nodeVars: Map<string, string>,
	nodeMap: Map<string, NodeInstance>
): string[][] {
	// Union-Find over string keys "nodeId:portIndex"
	const parent = new Map<string, string>();

	function find(x: string): string {
		if (!parent.has(x)) parent.set(x, x);
		let root = x;
		while (parent.get(root) !== root) root = parent.get(root)!;
		// Path compression
		let cur = x;
		while (cur !== root) {
			const next = parent.get(cur)!;
			parent.set(cur, root);
			cur = next;
		}
		return root;
	}

	function union(a: string, b: string): void {
		const ra = find(a);
		const rb = find(b);
		if (ra !== rb) parent.set(ra, rb);
	}

	// Register every endpoint and union the two ends of each connection
	for (const conn of acausalConns) {
		const srcKey = `${conn.sourceNodeId}:${conn.sourcePortIndex}`;
		const tgtKey = `${conn.targetNodeId}:${conn.targetPortIndex}`;
		find(srcKey);
		find(tgtKey);
		union(srcKey, tgtKey);
	}

	const portsByJunctionNode = new Map<string, string[]>();
	for (const conn of acausalConns) {
		for (const [nodeId, portIndex] of [
			[conn.sourceNodeId, conn.sourcePortIndex],
			[conn.targetNodeId, conn.targetPortIndex]
		] as const) {
			const node = nodeMap.get(nodeId);
			if (!node || !isAcausalJunctionNodeType(node.type)) continue;
			const key = `${nodeId}:${portIndex}`;
			if (!portsByJunctionNode.has(nodeId)) {
				portsByJunctionNode.set(nodeId, []);
			}
			const ports = portsByJunctionNode.get(nodeId)!;
			if (!ports.includes(key)) ports.push(key);
		}
	}

	for (const portKeys of portsByJunctionNode.values()) {
		for (let i = 1; i < portKeys.length; i++) {
			union(portKeys[0], portKeys[i]);
		}
	}

	// Collect all unique keys (endpoints that appeared in connections)
	const allKeys = new Set<string>();
	for (const conn of acausalConns) {
		allKeys.add(`${conn.sourceNodeId}:${conn.sourcePortIndex}`);
		allKeys.add(`${conn.targetNodeId}:${conn.targetPortIndex}`);
	}

	// Group keys by root
	const groups = new Map<string, string[]>();
	for (const key of allKeys) {
		const root = find(key);
		if (!groups.has(root)) groups.set(root, []);

		const [nodeId, portIdxStr] = key.split(':');
		const portIndex = parseInt(portIdxStr, 10);
		const varName = nodeVars.get(nodeId);
		const portName = resolveAcausalPortName(nodeId, portIndex, nodeMap);

		if (varName && portName) {
			const portExpr = `${varName}.${portName}`;
			// Deduplicate within group (a port might appear in multiple connections
			// that are all in the same component)
			if (!groups.get(root)!.includes(portExpr)) {
				groups.get(root)!.push(portExpr);
			}
		}
	}

	return [...groups.values()].filter((g) => g.length > 0);
}

/**
 * Collect the set of acausal import paths needed for a list of nodes.
 * Returns Map<importPath, Set<className>>.
 */
function collectAcausalImportGroups(nodes: NodeInstance[]): Map<string, Set<string>> {
	const groups = new Map<string, Set<string>>();
	for (const node of nodes) {
		if (!isAcausalNodeType(node.type)) continue;
		if (isAcausalJunctionNodeType(node.type)) continue;
		const importPath =
			acausalBlockImportPaths[node.type as keyof typeof acausalBlockImportPaths] ??
			'pathsim.acausal.lib';
		if (!groups.has(importPath)) groups.set(importPath, new Set());
		groups.get(importPath)!.add(node.type);
	}
	return groups;
}

/**
 * Generate Python code for a pure-acausal graph.
 * Produces an AcausalNetwork, adds components, wires connections, and compiles.
 */
function generateAcausalPythonCode(
	nodes: NodeInstance[],
	connections: Connection[],
	settings: SimulationSettings,
	codeContext: string,
	includeNodeIdMap: boolean = true,
	includeRun: boolean = true,
	acausalRuntimeMode: AcausalRuntimeMode = 'default'
): string {
	const lines: string[] = [];
	const acausalConns = connections.filter((c) => c.kind === 'acausal');
	const importGroups = collectAcausalImportGroups(nodes);
	const logDt = settings.dt_max || settings.dt || String(getSettingOrDefault(settings, 'dt'));

	// 1. Imports
	lines.push('# IMPORTS');
	lines.push('import numpy as np');
	lines.push(getAcausalImportLine(acausalRuntimeMode));
	lines.push('from pathsim.acausal.compiler import AcausalCompiler');
	lines.push(`from pathsim.solvers import ${getSettingOrDefault(settings, 'solver')}`);
	for (const [importPath, classes] of importGroups) {
		lines.push(`from ${importPath} import ${[...classes].join(', ')}`);
	}
	lines.push('');

	// 2. Code context
	if (codeContext.trim()) {
		lines.push('# CODE CONTEXT');
		lines.push(codeContext.trim());
		lines.push('');
	}

	// 3. Component instantiation
	lines.push('# COMPONENTS');
	const nodeVars = new Map<string, string>();
	const nodeMap = new Map<string, NodeInstance>();
	const varNames: string[] = [];
	const acausalComponentNames = new Set<string>();

	for (let i = 0; i < nodes.length; i++) {
		const node = nodes[i];
		nodeMap.set(node.id, node);

		if (isAcausalJunctionNodeType(node.type)) {
			continue;
		}

		const typeDef = nodeRegistry.get(node.type);
		if (!typeDef) continue;

		let varName = sanitizeName(node.name);
		if (!varName || varNames.includes(varName)) varName = `comp_${i}`;
		varNames.push(varName);
		nodeVars.set(node.id, varName);

		const validParamNames = new Set(typeDef.params.map((p) => p.name));
		const componentName = getUniqueAcausalComponentName(node.name, acausalComponentNames);
		const params = buildAcausalComponentParams(
			node,
			validParamNames,
			acausalRuntimeMode,
			componentName
		);

		if (params) {
			lines.push(`${varName} = ${typeDef.blockClass}(${params})`);
		} else {
			lines.push(`${varName} = ${typeDef.blockClass}()`);
		}
	}

	// 4. Node ID mapping (for data extraction)
	if (includeNodeIdMap) {
		lines.push('');
		lines.push('# NODE ID MAPPING');
		lines.push('_node_id_map = {');
		for (const [nodeId, varName] of nodeVars) {
			lines.push(`    id(${varName}): "${nodeId}",`);
		}
		lines.push('}');
		lines.push('');
		lines.push('# NODE NAME MAPPING');
		lines.push('_node_name_map = {');
		for (const node of nodes) {
			const escapedName = node.name.replace(/"/g, '\\"');
			lines.push(`    "${node.id}": "${escapedName}",`);
		}
		lines.push('    "_acausal_net": "Acausal Network",');
		lines.push('}');
	}

	// 5. Network and add
	lines.push('');
	lines.push('# NETWORK');
	lines.push(getAcausalNetworkLine(acausalRuntimeMode));
	lines.push(`net.add(${varNames.join(', ')})`);

	// 6. Connections — one net.connect() per junction
	lines.push('');
	lines.push('# CONNECTIONS');
	const connectGroups = buildAcausalConnectGroups(acausalConns, nodeVars, nodeMap);
	for (const group of connectGroups) {
		lines.push(`net.connect(${group.join(', ')})`);
	}

	// 7. Compile to logging-enabled Simulation so PathView can browse all named signals
	lines.push('');
	lines.push('# COMPILE');
	lines.push('sim, _acausal_signal_names, _acausal_signal_units = AcausalCompiler(net).compile_for_logging(');
	lines.push(`    Solver=${getSettingOrDefault(settings, 'solver')},`);
	lines.push(`    dt=${logDt},`);
	lines.push(`    dt_min=${getSettingOrDefault(settings, 'dt_min')},`);
	lines.push(`    tolerance_lte_rel=${getSettingOrDefault(settings, 'rtol')},`);
	lines.push(`    tolerance_lte_abs=${getSettingOrDefault(settings, 'atol')},`);
	lines.push(`    tolerance_fpi=${getSettingOrDefault(settings, 'ftol')},`);
	lines.push(')');

	// 8. Set up streaming infrastructure
	lines.push('');
	lines.push('# STREAMING SETUP');
	lines.push('blocks = list(sim.blocks)');
	lines.push('_acausal_labels = list(getattr(sim, "_acausal_signal_names", _acausal_signal_names))');

	// 9. Run
	if (includeRun) {
		lines.push('');
		lines.push('# RUN');
		lines.push(`sim.run(duration=${getSettingOrDefault(settings, 'duration')}, reset=True)`);
	}

	return lines.join('\n');
}

/**
 * Generate Python code for a mixed causal+acausal graph.
 * Compiles the acausal sub-network as a causal block via compile_as_block(), then
 * includes it alongside any causal blocks in a standard Simulation.
 */
function generateMixedPythonCode(
	nodes: NodeInstance[],
	connections: Connection[],
	settings: SimulationSettings,
	codeContext: string,
	includeNodeIdMap: boolean = true,
	includeRun: boolean = true,
	acausalRuntimeMode: AcausalRuntimeMode = 'default'
): string {
	const lines: string[] = [];

	const acausalNodes = nodes.filter((n) => isAcausalNodeType(n.type));
	const causalNodes = nodes.filter((n) => !isAcausalNodeType(n.type) && !isInterface(n));
	const acausalConns = connections.filter((c) => c.kind === 'acausal');
	const causalConns = connections.filter((c) => c.kind !== 'acausal');

	const acausalImports = collectAcausalImportGroups(acausalNodes);
	const causalImports = collectBlockImportGroups(causalNodes);

	// 1. Imports
	lines.push('# IMPORTS');
	lines.push('import numpy as np');
	lines.push(getAcausalImportLine(acausalRuntimeMode));
	for (const [importPath, classes] of acausalImports) {
		lines.push(`from ${importPath} import ${[...classes].join(', ')}`);
	}
	lines.push('from pathsim import Simulation, Connection');
	for (const [importPath] of causalImports) {
		lines.push(`from ${importPath} import *`);
	}
	if (!causalImports.has('pathsim.blocks')) {
		lines.push('from pathsim.blocks import *');
	}
	lines.push(`from pathsim.solvers import ${getSettingOrDefault(settings, 'solver')}`);
	lines.push('');

	// 2. Code context
	if (codeContext.trim()) {
		lines.push('# CODE CONTEXT');
		lines.push(codeContext.trim());
		lines.push('');
	}

	// 3. Acausal components
	lines.push('# ACAUSAL COMPONENTS');
	const nodeVars = new Map<string, string>();
	const nodeMap = new Map<string, NodeInstance>();
	const acausalVarNames: string[] = [];
	const acausalComponentNames = new Set<string>();

	for (let i = 0; i < acausalNodes.length; i++) {
		const node = acausalNodes[i];
		nodeMap.set(node.id, node);
		if (isAcausalJunctionNodeType(node.type)) continue;
		const typeDef = nodeRegistry.get(node.type);
		if (!typeDef) continue;
		let varName = sanitizeName(node.name);
		if (!varName || acausalVarNames.includes(varName)) varName = `comp_${i}`;
		acausalVarNames.push(varName);
		nodeVars.set(node.id, varName);
		const validParamNames = new Set(typeDef.params.map((p) => p.name));
		const componentName = getUniqueAcausalComponentName(node.name, acausalComponentNames);
		const params = buildAcausalComponentParams(
			node,
			validParamNames,
			acausalRuntimeMode,
			componentName
		);
		lines.push(
			params
				? `${varName} = ${typeDef.blockClass}(${params})`
				: `${varName} = ${typeDef.blockClass}()`
		);
	}

	// 4. Acausal network + connections
	lines.push('');
	lines.push('# ACAUSAL NETWORK');
	lines.push(getAcausalNetworkLine(acausalRuntimeMode));
	lines.push(`net.add(${acausalVarNames.join(', ')})`);
	lines.push('');
	lines.push('# ACAUSAL CONNECTIONS');
	const connectGroups = buildAcausalConnectGroups(acausalConns, nodeVars, nodeMap);
	for (const group of connectGroups) {
		lines.push(`net.connect(${group.join(', ')})`);
	}

	// 5. Compile acausal sub-network as a causal block
	lines.push('');
	lines.push('# COMPILE ACAUSAL AS BLOCK');
	lines.push('acausal_block, _input_map, output_names = net.compile_as_block()');

	// 6. Causal blocks
	const causalVarNames: string[] = [];
	if (causalNodes.length > 0) {
		lines.push('');
		lines.push('# CAUSAL BLOCKS');
		causalNodes.forEach((node, index) => {
			const typeDef = nodeRegistry.get(node.type);
			if (!typeDef) return;
			let varName = sanitizeName(node.name);
			if (!varName || [...acausalVarNames, ...causalVarNames].includes(varName)) {
				varName = `block_${index}`;
			}
			causalVarNames.push(varName);
			nodeVars.set(node.id, varName);
			const validParamNames = new Set(typeDef.params.map((p) => p.name));
			const params = generateBlockParams(node.params, validParamNames);
			lines.push(params ? `${varName} = ${typeDef.blockClass}(${params})` : `${varName} = ${typeDef.blockClass}()`);
		});
	}

	// 7. Node ID/name maps
	if (includeNodeIdMap) {
		lines.push('');
		lines.push('# NODE ID MAPPING');
		lines.push('_node_id_map = {');
		for (const [nodeId, varName] of nodeVars) {
			lines.push(`    id(${varName}): "${nodeId}",`);
		}
		lines.push('}');
		lines.push('');
		lines.push('# NODE NAME MAPPING');
		lines.push('_node_name_map = {');
		for (const node of nodes) {
			const escapedName = node.name.replace(/"/g, '\\"');
			lines.push(`    "${node.id}": "${escapedName}",`);
		}
		lines.push('    "_acausal_net": "Acausal Network",');
		lines.push('}');
	}

	// 8. Simulation: compiled block + causal blocks + causal connections
	const allBlockVars = ['acausal_block', ...causalVarNames];
	lines.push('');
	lines.push('# SIMULATION');
	lines.push(`blocks = [${allBlockVars.join(', ')}]`);
	lines.push('');
	lines.push('connections = [');
	const causalConnLines = generateConnectionLines(causalConns, nodeVars, '    ');
	for (const line of causalConnLines) {
		lines.push(line);
	}
	lines.push(']');
	lines.push('');
	generateSimulationSetup(settings, false, lines);

	// 9. Streaming setup: read live from compiled block outputs
	lines.push('');
	lines.push('# STREAMING SETUP');
	lines.push('_acausal_sys = next((b for b in blocks if type(b).__name__ == "CompiledAcausalSystem"), None)');
	lines.push('_acausal_labels = list(output_names)');

	// 10. Run
	if (includeRun) {
		lines.push('');
		lines.push('# RUN');
		lines.push(`sim.run(duration=${getSettingOrDefault(settings, 'duration')}, reset=True)`);
	}

	return lines.join('\n');
}

/**
 * Generate Python code from graph state
 * @param includeNodeIdMap - Include node ID mapping for web data extraction (default: true)
 * @param includeRun - Append sim.run() call (default: true, false for streaming)
 */
export function generatePythonCode(
	nodes: NodeInstance[],
	connections: Connection[],
	settings: SimulationSettings,
	codeContext: string,
	includeNodeIdMap: boolean = true,
	events: EventInstance[] = [],
	includeRun: boolean = true,
	acausalRuntimeMode: AcausalRuntimeMode = 'default'
): string {
	// Delegate to mixed generator when both acausal and causal nodes are present
	if (isMixedGraph(nodes)) {
		return generateMixedPythonCode(
			nodes,
			connections,
			settings,
			codeContext,
			includeNodeIdMap,
			includeRun,
			acausalRuntimeMode
		);
	}

	// Delegate to acausal generator for pure-acausal graphs
	if (hasAcausalNodes(nodes)) {
		return generateAcausalPythonCode(
			nodes,
			connections,
			settings,
			codeContext,
			includeNodeIdMap,
			includeRun,
			acausalRuntimeMode
		);
	}

	const lines: string[] = [];

	// Check if we have any subsystems
	const hasSubsystems = nodes.some(isSubsystem);

	// Check if we have any events
	const hasEvents = events.length > 0;
	const eventClasses = new Set(
		events.map(e => eventRegistry.get(e.type)?.eventClass).filter(Boolean)
	);

	// Collect block import paths dynamically
	const importGroups = collectBlockImportGroups(nodes);

	// 1. Imports
	lines.push('# IMPORTS');
	lines.push('import numpy as np');
	if (hasSubsystems) {
		lines.push('from pathsim import Simulation, Connection, Subsystem, Interface');
	} else {
		lines.push('from pathsim import Simulation, Connection');
	}
	for (const [importPath] of importGroups) {
		lines.push(`from ${importPath} import *`);
	}
	// Ensure at least pathsim.blocks is imported even if no blocks
	if (!importGroups.has('pathsim.blocks')) {
		lines.push('from pathsim.blocks import *');
	}
	lines.push(`from pathsim.solvers import ${getSettingOrDefault(settings, 'solver')}`);
	if (hasEvents) {
		lines.push(`from pathsim.events import ${[...eventClasses].join(', ')}`);
	}
	lines.push('');

	// 2. Code context (user-defined variables/functions)
	if (codeContext.trim()) {
		lines.push('# CODE CONTEXT');
		lines.push(codeContext.trim());
		lines.push('');
	}

	// 3. Create blocks
	lines.push('# BLOCKS');
	const nodeVars = new Map<string, string>();
	const varNames: string[] = [];

	// First, generate subsystems (they need to be defined before being used)
	const subsystemNodes = nodes.filter(isSubsystem);
	for (const subsystemNode of subsystemNodes) {
		generateSubsystemCode(subsystemNode, nodeVars, varNames, lines);
	}

	// Then generate regular blocks (excluding subsystems and interfaces)
	const regularNodes = nodes.filter((n) => !isSubsystem(n) && !isInterface(n));

	regularNodes.forEach((node, index) => {
		const typeDef = nodeRegistry.get(node.type);
		if (!typeDef) {
			console.warn(`Unknown node type: ${node.type}`);
			return;
		}

		let varName = sanitizeName(node.name);
		if (!varName || varNames.includes(varName)) {
			varName = `block_${index}`;
		}
		varNames.push(varName);
		nodeVars.set(node.id, varName);

		const validParamNames = new Set(typeDef.params.map(p => p.name));
		const params = generateBlockParams(node.params, validParamNames);

		if (params) {
			lines.push(`${varName} = ${typeDef.blockClass}(${params})`);
		} else {
			lines.push(`${varName} = ${typeDef.blockClass}()`);
		}
	});

	lines.push('');
	lines.push(...generateListDefinition('blocks', varNames));
	lines.push('');

	// Create node ID mapping for data extraction (only for web simulation)
	if (includeNodeIdMap) {
		lines.push('# NODE ID MAPPING (for data extraction)');
		lines.push('_node_id_map = {');
		for (const [nodeId, varName] of nodeVars) {
			lines.push(`    id(${varName}): "${nodeId}",`);
		}
		lines.push('}');
		lines.push('');

		lines.push('# NODE NAME MAPPING');
		lines.push('_node_name_map = {');
		const allNodes = getAllNodesRecursively(nodes);
		for (const node of allNodes) {
			const escapedName = node.name.replace(/"/g, '\\"');
			lines.push(`    "${node.id}": "${escapedName}",`);
		}
		lines.push('}');
		lines.push('');
	}

	// 4. Connections (grouped by source for multi-target syntax)
	lines.push('# CONNECTIONS');
	lines.push('connections = [');
	const connLines = generateConnectionLines(connections, nodeVars, '    ');
	for (const line of connLines) {
		lines.push(line);
	}
	lines.push(']');
	lines.push('');

	// 5. Events (if any)
	if (hasEvents) {
		lines.push('# EVENTS');
		const eventVarNames = generateEventDefinitions(events, varNames, lines);
		lines.push('');
		lines.push(...generateListDefinition('events', eventVarNames));
		lines.push('');
	}

	// 6. Simulation setup
	lines.push('# SIMULATION');
	generateSimulationSetup(settings, hasEvents, lines);

	// 7. Run simulation (omitted for streaming mode)
	if (includeRun) {
		lines.push('');
		lines.push('# RUN');
		lines.push(`sim.run(duration=${getSettingOrDefault(settings, 'duration')}, reset=True)`);
	}

	return lines.join('\n');
}

/**
 * Generate well-formatted Python code for standalone export
 */
function generateFormattedPythonCode(
	nodes: NodeInstance[],
	connections: Connection[],
	settings: SimulationSettings,
	codeContext: string,
	events: EventInstance[] = []
): string {
	const lines: string[] = [];
	const divider = '# ' + '─'.repeat(76);
	const now = new Date();
	const timestamp = now.toISOString().replace('T', ' ').split('.')[0];

	// Header banner
	lines.push('#!/usr/bin/env python3');
	lines.push('# -*- coding: utf-8 -*-');
	lines.push('"""');
	lines.push('PathSim Simulation');
	lines.push('==================');
	lines.push('');
	lines.push(`Generated by PathView on ${timestamp}`);
	lines.push('https://view.pathsim.org');
	lines.push('');
	lines.push('PathSim documentation: https://docs.pathsim.org');
	lines.push('"""');
	lines.push('');

	// Delegate to mixed generator for mixed causal+acausal graphs
	if (isMixedGraph(nodes)) {
		lines.push(generateMixedPythonCode(nodes, connections, settings, codeContext, false, true));
		return lines.join('\n');
	}

	// Delegate to acausal generator for pure-acausal graphs
	if (hasAcausalNodes(nodes)) {
		lines.push(generateAcausalPythonCode(nodes, connections, settings, codeContext, false, true));
		return lines.join('\n');
	}

	// Check if we have subsystems
	const hasSubsystems = nodes.some(isSubsystem);

	// Check if we have events
	const hasEvents = events.length > 0;
	const eventClasses = new Set(
		events.map(e => eventRegistry.get(e.type)?.eventClass).filter(Boolean)
	);

	// Imports section
	lines.push(divider);
	lines.push('# IMPORTS');
	lines.push(divider);
	lines.push('');
	lines.push('import numpy as np');
	lines.push('import matplotlib.pyplot as plt');
	lines.push('');
	if (hasSubsystems) {
		lines.push('from pathsim import Simulation, Connection, Subsystem, Interface');
	} else {
		lines.push('from pathsim import Simulation, Connection');
	}

	// Collect block classes grouped by import path
	const importGroups = collectBlockImportGroups(nodes);

	// Generate explicit imports for each import path
	for (const [importPath, classes] of importGroups) {
		const sorted = [...classes].sort();
		if (sorted.length === 1) {
			lines.push(`from ${importPath} import ${sorted[0]}`);
		} else {
			lines.push(`from ${importPath} import (`);
			for (let i = 0; i < sorted.length; i++) {
				const comma = i < sorted.length - 1 ? ',' : '';
				lines.push(`    ${sorted[i]}${comma}`);
			}
			lines.push(')');
		}
	}

	lines.push(`from pathsim.solvers import ${getSettingOrDefault(settings, 'solver')}`);
	if (hasEvents) {
		lines.push(`from pathsim.events import ${[...eventClasses].join(', ')}`);
	}
	lines.push('');

	// Code context (user-defined variables/functions)
	if (codeContext.trim()) {
		lines.push(divider);
		lines.push('# USER-DEFINED CODE');
		lines.push(divider);
		lines.push('');
		lines.push(codeContext.trim());
		lines.push('');
	}

	// Blocks section - grouped by category
	lines.push(divider);
	lines.push('# BLOCKS');
	lines.push(divider);

	const nodeVars = new Map<string, string>();
	const varNames: string[] = [];
	let nodeIndex = 0;

	// With nested structure, input nodes are already root-level
	const rootNodes = nodes;

	// First, generate subsystems (they need to be defined before being used in connections)
	const subsystemNodes = rootNodes.filter(isSubsystem);
	for (const subsystemNode of subsystemNodes) {
		generateSubsystemCode(subsystemNode, nodeVars, varNames, lines, '', { formatted: true });
	}

	// Then generate regular blocks (excluding subsystems and interfaces)
	// Group only root-level, non-subsystem, non-interface nodes
	const regularRootNodes = rootNodes.filter((n) => !isSubsystem(n) && !isInterface(n));
	const regularBlocksByCategory = groupNodesByCategory(regularRootNodes);

	for (const category of BLOCK_CATEGORY_ORDER) {
		if (category === 'Subsystem') continue; // Already handled above
		const group = regularBlocksByCategory.get(category);
		if (!group || group.length === 0) continue;

		lines.push('');
		lines.push(`# ${category}`);

		for (const { node, typeDef } of group) {
			// Generate variable name
			let varName = sanitizeName(node.name);
			if (!varName || varNames.includes(varName)) {
				varName = `block_${nodeIndex}`;
			}
			varNames.push(varName);
			nodeVars.set(node.id, varName);
			nodeIndex++;

			// Get valid param names from type definition
			const validParamNames = new Set(typeDef!.params.map((p) => p.name));

			// Generate parameter string (multi-line for readability)
			const params = generateBlockParams(node.params, validParamNames, true);

			if (params) {
				lines.push(`${varName} = ${typeDef!.blockClass}(${params})`);
			} else {
				lines.push(`${varName} = ${typeDef!.blockClass}()`);
			}
		}
	}

	// Handle any remaining categories (excluding Subsystem)
	for (const [category, group] of regularBlocksByCategory) {
		if (BLOCK_CATEGORY_ORDER.includes(category)) continue;

		lines.push('');
		lines.push(`# ${category}`);

		for (const { node, typeDef } of group) {
			let varName = sanitizeName(node.name);
			if (!varName || varNames.includes(varName)) {
				varName = `block_${nodeIndex}`;
			}
			varNames.push(varName);
			nodeVars.set(node.id, varName);
			nodeIndex++;

			const validParamNames = new Set(typeDef!.params.map((p) => p.name));
			const params = generateBlockParams(node.params, validParamNames, true);

			if (params) {
				lines.push(`${varName} = ${typeDef!.blockClass}(${params})`);
			} else {
				lines.push(`${varName} = ${typeDef!.blockClass}()`);
			}
		}
	}

	// Add blocks list at end of section
	lines.push('');
	lines.push(...generateListDefinition('blocks', varNames));
	lines.push('');

	// Connections section
	lines.push(divider);
	lines.push('# CONNECTIONS');
	lines.push(divider);
	lines.push('');

	// Connections (grouped by source for multi-target syntax)
	if (connections.length === 0) {
		lines.push('connections = []');
	} else {
		lines.push('connections = [');
		const connLines = generateConnectionLines(connections, nodeVars, '    ');
		for (const line of connLines) {
			lines.push(line);
		}
		lines.push(']');
	}
	lines.push('');

	// Events section (if any)
	if (hasEvents) {
		lines.push(divider);
		lines.push('# EVENTS');
		lines.push(divider);
		lines.push('');
		const eventVarNames = generateEventDefinitions(events, varNames, lines, true);
		lines.push('');
		lines.push(...generateListDefinition('events', eventVarNames));
		lines.push('');
	}

	// Simulation section
	lines.push(divider);
	lines.push('# SIMULATION');
	lines.push(divider);
	lines.push('');
	generateSimulationSetup(settings, hasEvents, lines);
	lines.push('');

	// Main block
	lines.push(divider);
	lines.push('# MAIN');
	lines.push(divider);
	lines.push('');
	lines.push("if __name__ == '__main__':");
	lines.push('');
	lines.push('    # Run simulation');
	lines.push(`    sim.run(duration=${getSettingOrDefault(settings, 'duration')})`);
	lines.push('');
	lines.push('    # Plot results');
	lines.push('    sim.plot()');
	lines.push('    plt.show()');
	lines.push('');

	return lines.join('\n');
}

/**
 * Run streaming simulation from graph state with live updates
 * @param onUpdate - Callback called for each streaming update
 */
export async function runGraphStreamingSimulation(
	nodes: NodeInstance[],
	connections: Connection[],
	settings: SimulationSettings,
	codeContext: string,
	events: EventInstance[] = [],
	onUpdate?: (result: SimulationResult) => void
): Promise<SimulationResult | null> {
	const hasAcausal = hasAcausalNodes(nodes);
	const currentBackendType = getBackendType();
	const canUsePyodideSympy = hasAcausal && canRunAcausalInPyodide(nodes);
	const explicitFlask = isFlaskBackendExplicitlyRequested();
	let acausalRuntimeMode: AcausalRuntimeMode = 'default';

	if (canUsePyodideSympy && !explicitFlask) {
		acausalRuntimeMode = 'pyodide-sympy';
		switchBackend('pyodide');
	} else if (hasAcausal && currentBackendType !== 'flask') {
		const flaskHost = await findAvailableFlaskHost();
		if (!flaskHost) {
			const unsupported = getUnsupportedPyodideAcausalTypes(nodes);
			const unsupportedDetails =
				unsupported.length > 0 ? ` Unsupported components: ${unsupported.join(', ')}.` : '';
			throw new Error(
				'This acausal model requires the Flask backend. ' +
					`Pyodide currently supports only the SymPy electrical subset (${[...PYODIDE_SYMPY_ACAUSAL_COMPONENTS].join(', ')}).` +
					unsupportedDetails +
					' Start the Flask server with: python -m pathview'
			);
		}
		setFlaskHost(flaskHost);
		switchBackend('flask');
		await initBackend();
	}

	// Generate code without sim.run() - streaming will handle execution
	const code = generatePythonCode(
		nodes,
		connections,
		settings,
		codeContext,
		true,
		events,
		false,
		acausalRuntimeMode
	);
	const duration = getSettingOrDefault(settings, 'duration');
	const streamingCode = hasAcausal
		? generateAcausalStreamingStartCode(String(duration), 10)
		: undefined;
	return runStreamingSimulation(code, String(duration), onUpdate, streamingCode, {
		forceReinitialize: acausalRuntimeMode === 'pyodide-sympy'
	});
}

/**
 * Export graph to standalone Python script
 */
export function exportToPython(
	nodes: NodeInstance[],
	connections: Connection[],
	settings: SimulationSettings,
	codeContext: string,
	events: EventInstance[] = []
): string {
	return generateFormattedPythonCode(nodes, connections, settings, codeContext, events);
}

/**
 * Generate Python code for a single block
 * For Subsystem blocks, generates the full hierarchical code with internal blocks/connections
 */
export function generateBlockCode(
	node: NodeInstance,
	allNodes?: NodeInstance[],
	allConnections?: Connection[]
): string {
	const typeDef = nodeRegistry.get(node.type);
	if (!typeDef) return '';

	// Handle Interface blocks - generate parent Subsystem code instead
	if (node.type === NODE_TYPES.INTERFACE) {
		const rootNodes = allNodes || graphStore.getAllNodes();
		const parentSubsystem = findParentSubsystem(rootNodes, node.id);
		if (parentSubsystem) {
			return generateBlockCode(parentSubsystem, allNodes, allConnections);
		}
		return '# Interface block (no parent subsystem found)';
	}

	const varName = sanitizeName(node.name) || 'block';

	// Handle Subsystem blocks specially - generate full hierarchical code
	if (node.type === NODE_TYPES.SUBSYSTEM && allNodes && allConnections) {
		const lines: string[] = [];
		const nodeVars = new Map<string, string>();
		const varNames: string[] = [];

		generateSubsystemCode(node, nodeVars, varNames, lines, '', { formatted: true });

		return lines.join('\n');
	}

	// Regular block - simple code generation
	const validParamNames = new Set(typeDef.params.map((p) => p.name));
	const params = generateBlockParams(node.params, validParamNames, true);

	if (params) {
		return `${varName} = ${typeDef.blockClass}(${params})`;
	}
	return `${varName} = ${typeDef.blockClass}()`;
}

/**
 * Generate Python code for a single event instance
 */
export function generateSingleEventCode(event: EventInstance): string {
	const typeDef = eventRegistry.get(event.type);
	if (!typeDef) return '';

	const varName = sanitizeName(event.name) || 'event';
	const validParamNames = new Set(typeDef.params.map((p) => p.name));
	const params = generateEventParams(event.params, validParamNames, true);

	if (params) {
		return `${varName} = ${typeDef.eventClass}(${params})`;
	}
	return `${varName} = ${typeDef.eventClass}()`;
}

/**
 * Extract node parameters for validation
 * Returns a map of nodeId -> { paramName: paramValue }
 */
function extractNodeParams(nodes: NodeInstance[]): Record<string, Record<string, string>> {
	const result: Record<string, Record<string, string>> = {};

	for (const node of nodes) {
		const typeDef = nodeRegistry.get(node.type);
		if (!typeDef) continue;

		const validParamNames = new Set(typeDef.params.map((p) => p.name));
		const nodeParams: Record<string, string> = {};

		for (const [name, value] of Object.entries(node.params)) {
			// Skip null/undefined/empty
			if (value === null || value === undefined || value === '') continue;
			// Skip internal params
			if (name.startsWith('_')) continue;
			// Skip params not in type definition
			if (!validParamNames.has(name)) continue;

			nodeParams[name] = String(value);
		}

		if (Object.keys(nodeParams).length > 0) {
			result[node.id] = nodeParams;
		}
	}

	return result;
}

/**
 * Validate graph before running simulation
 * Checks code context syntax and all parameter expressions
 */
export async function validateGraphSimulation(
	nodes: NodeInstance[],
	codeContext: string
): Promise<ValidationResult> {
	const nodeParams = extractNodeParams(nodes);
	return validateGraphBridge(codeContext, nodeParams);
}

export type { ValidationResult };
