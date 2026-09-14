/**
 * Converters between PathView types and SvelteFlow types
 */

import type { Node, Edge } from '@xyflow/svelte';
import type { Connection, Annotation } from '$lib/nodes/types';
import type { EventInstance } from '$lib/events/types';
import { HANDLE_ID } from '$lib/constants/handles';

/** Canvas node types that are blocks with ports: regular blocks and bus blocks */
const BLOCK_NODE_TYPES = new Set(['pathview', 'busBlock']);

/** Whether a canvas node is a block with ports, as opposed to an event or annotation */
export function isBlockFlowNode(node: Node): boolean {
	return BLOCK_NODE_TYPES.has(node.type ?? '');
}

/**
 * Convert an EventInstance to a SvelteFlow Node
 */
export function toEventNode(event: EventInstance): Node<EventInstance> {
	return {
		id: event.id,
		type: 'eventNode',
		position: { ...event.position },
		data: event,
		// Explicit center origin for correct bounds calculation
		origin: [0.5, 0.5] as [number, number],
		selectable: true,
		draggable: true,
		connectable: false,
		deletable: true
	};
}

/**
 * Convert an Annotation to a SvelteFlow Node
 */
export function toAnnotationNode(annotation: Annotation): Node<Annotation> {
	return {
		id: annotation.id,
		type: 'annotation',
		position: { ...annotation.position },
		data: annotation,
		width: annotation.width,
		height: annotation.height,
		// Annotations use top-left origin (overrides global nodeOrigin)
		origin: [0, 0] as [number, number],
		selectable: true,
		draggable: true,
		connectable: false,
		deletable: true
	};
}

/**
 * Convert a Connection to a SvelteFlow Edge
 */
export function toFlowEdge(conn: Connection): Edge {
	return {
		id: conn.id,
		source: conn.sourceNodeId,
		sourceHandle: HANDLE_ID.output(conn.sourceNodeId, conn.sourcePortIndex),
		target: conn.targetNodeId,
		targetHandle: HANDLE_ID.input(conn.targetNodeId, conn.targetPortIndex),
		type: 'orthogonal',
		data: { waypoints: conn.waypoints, label: conn.label },
		selectable: true,
		deletable: true,
		animated: false
	};
}
