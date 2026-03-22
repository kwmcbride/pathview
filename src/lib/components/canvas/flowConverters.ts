/**
 * Converters between PathView types and SvelteFlow types
 */

import type { Node, Edge } from '@xyflow/svelte';
import type { Connection, Annotation } from '$lib/nodes/types';
import type { EventInstance } from '$lib/events/types';
import { HANDLE_ID } from '$lib/constants/handles';
import { ACAUSAL_DOMAIN_COLORS } from '$lib/utils/colors';

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
	const isAcausal = conn.kind === 'acausal';
	const domainColor = isAcausal
		? ACAUSAL_DOMAIN_COLORS[conn.domain ?? ''] ?? ACAUSAL_DOMAIN_COLORS.default
		: undefined;

	return {
		id: conn.id,
		source: conn.sourceNodeId,
		sourceHandle: isAcausal
			? HANDLE_ID.acausal(conn.sourceNodeId, conn.sourcePortIndex)
			: HANDLE_ID.output(conn.sourceNodeId, conn.sourcePortIndex),
		target: conn.targetNodeId,
		targetHandle: isAcausal
			? HANDLE_ID.acausal(conn.targetNodeId, conn.targetPortIndex)
			: HANDLE_ID.input(conn.targetNodeId, conn.targetPortIndex),
		type: isAcausal ? 'acausal' : 'orthogonal',
		data: { waypoints: conn.waypoints, domainColor, domain: conn.domain },
		selectable: true,
		deletable: true,
		animated: false
	};
}
