/**
 * Node masks
 *
 * A "mask" is a UI-only configuration that can:
 * - override the node silhouette via CSS clip-path
 * - render an optional SVG overlay inside the node body
 * - (optionally) draw port labels on the overlay
 */

import type { NodeInstance, NodeTypeDefinition } from '$lib/nodes/types';

/** How to render text labels for ports */
export type MaskPortLabelsMode = 'none' | 'svg';

/** Parameters passed to the mask renderer */
export interface MaskRenderContext {
	width: number;
	height: number;
	rotation: number;
	node: NodeInstance;
	typeDef?: NodeTypeDefinition;
}

export interface NodeMask {
	/** Block type this applies to (e.g. 'Constant') */
	type: string;

	/**
	 * Optional silhouette clip-path for the node body.
	 * Provide a CSS clip-path value, e.g.
	 * - `path('...')`
	 * - `polygon(...)`
	 */
	clipPath?: string;

	/** Optional extra padding inside node-content when a mask is present */
	contentPadding?: string;

	/** Whether we should render port labels inside the SVG overlay */
	portLabels?: MaskPortLabelsMode;

	/**
	 * Render an SVG overlay (returned as a raw SVG string).
	 * Return null to render nothing.
	 */
	renderSvg?: (ctx: MaskRenderContext) => string | null;

	/** Optional hook for debugging mask errors */
	onError?: (err: unknown, ctx: MaskRenderContext) => void;
}
