/**
 * Edge highlight - colors of edges attached to the hovered handle or the selected node
 *
 * Computed once per hover or selection change, so an edge only re-renders when
 * its own highlight changes instead of every edge evaluating each change.
 */

import type { Edge } from '@xyflow/svelte';
import { SvelteMap } from 'svelte/reactivity';
import { hoveredHandle, selectedNodeHighlight } from './hoveredHandle';

/** Highlight color when the node defines none */
const ACCENT = 'var(--accent)';

/** Edge id to highlight color; absent when the edge is not highlighted */
export const edgeHighlights = new SvelteMap<string, string>();

export function createEdgeHighlighter(getEdges: () => Edge[]) {
	let hovered: { nodeId: string; handleId: string; color?: string } | null = null;
	let selected: { nodeId: string; color?: string } | null = null;

	/** Recompute highlights, e.g. after the edge list changed */
	function refresh(): void {
		const next = new Map<string, string>();
		if (hovered || selected) {
			for (const edge of getEdges()) {
				const onHoveredHandle =
					hovered !== null &&
					((edge.source === hovered.nodeId && edge.sourceHandle === hovered.handleId) ||
						(edge.target === hovered.nodeId && edge.targetHandle === hovered.handleId));
				if (onHoveredHandle) {
					next.set(edge.id, hovered!.color || ACCENT);
				} else if (selected && (edge.source === selected.nodeId || edge.target === selected.nodeId)) {
					next.set(edge.id, selected.color || ACCENT);
				}
			}
		}

		for (const id of [...edgeHighlights.keys()]) {
			if (!next.has(id)) edgeHighlights.delete(id);
		}
		for (const [id, color] of next) {
			if (edgeHighlights.get(id) !== color) edgeHighlights.set(id, color);
		}
	}

	const unsubscribers = [
		hoveredHandle.subscribe((h) => {
			hovered = h;
			refresh();
		}),
		selectedNodeHighlight.subscribe((s) => {
			selected = s;
			refresh();
		})
	];

	return {
		refresh,
		destroy: () => unsubscribers.forEach((unsubscribe) => unsubscribe())
	};
}
