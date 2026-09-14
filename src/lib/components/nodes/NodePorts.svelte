<script lang="ts">
	import { Handle, Position } from '@xyflow/svelte';
	import type { PortInstance } from '$lib/nodes/types';
	import { hoveredHandle } from '$lib/stores/hoveredHandle';
	import { showTooltip, hideTooltip } from '$lib/components/Tooltip.svelte';
	import { getPortPositionCalc } from '$lib/constants/dimensions';
	import { truncatePortLabel } from '$lib/utils/portLabels';

	/**
	 * Port handles and port labels of a block node. Sits inside the node element,
	 * whose edges the handles and labels are positioned against.
	 */
	interface Props {
		id: string;
		inputs: PortInstance[];
		outputs: PortInstance[];
		rotation: number;
		nodeColor: string;
		showInputLabels: boolean;
		showOutputLabels: boolean;
		/** Names shown for the inputs instead of the port names, e.g. derived signal names */
		inputNames?: string[];
	}

	let { id, inputs, outputs, rotation, nodeColor, showInputLabels, showOutputLabels, inputNames }: Props = $props();

	// Actual visibility: setting is ON and ports exist (single source of truth)
	const hasVisibleInputLabels = $derived(showInputLabels && inputs.length > 0);
	const hasVisibleOutputLabels = $derived(showOutputLabels && outputs.length > 0);

	const inputName = (port: PortInstance, index: number) => inputNames?.[index] ?? port.name;

	// Calculate actual port positions based on rotation
	// 0: inputs left, outputs right (default)
	// 1: inputs top, outputs bottom
	// 2: inputs right, outputs left
	// 3: inputs bottom, outputs top
	const inputPosition = $derived.by(() => {
		switch (rotation) {
			case 1: return Position.Top;
			case 2: return Position.Right;
			case 3: return Position.Bottom;
			default: return Position.Left;
		}
	});

	const outputPosition = $derived.by(() => {
		switch (rotation) {
			case 1: return Position.Bottom;
			case 2: return Position.Left;
			case 3: return Position.Top;
			default: return Position.Right;
		}
	});

	// Port is horizontal (left/right) or vertical (top/bottom)
	const isVertical = $derived(rotation === 1 || rotation === 3);

	/** Inline style for a port label, positioning it outside the block edge
	 *  next to its handle. The handle/wire is always *below* the label from
	 *  the label's perspective — i.e. the anchor point sits at the label's
	 *  bottom-left or bottom-right corner.
	 *
	 *  Horizontal block: text horizontal, label sits just above the wire stub.
	 *  Vertical block: `writing-mode: sideways-{lr|rl}` rotates the text
	 *    parallel to the wire (no transform tricks needed for positioning,
	 *    so the perpendicular offset works in screen-space directly). Top
	 *    edge reads bottom-to-top, bottom edge top-to-bottom — both read
	 *    *outward* from the block. */
	function portLabelStyle(isInput: boolean, portIndex: number, total: number): string {
		const pos = getPortPositionCalc(portIndex, total);
		const GAP = 10; // distance from block edge along the wire
		const PERP = 5; // perpendicular offset off the wire path

		// Map (rotation, isInput) → which block edge hosts the port.
		let edge: 'left' | 'right' | 'top' | 'bottom';
		if (rotation === 0) edge = isInput ? 'left' : 'right';
		else if (rotation === 2) edge = isInput ? 'right' : 'left';
		else if (rotation === 1) edge = isInput ? 'top' : 'bottom';
		else edge = isInput ? 'bottom' : 'top';

		switch (edge) {
			case 'left':
				// Anchor (port) at label bottom-right.
				return `right: 100%; margin-right: ${GAP}px; top: ${pos}; transform: translateY(calc(-100% - ${PERP}px)); text-align: right;`;
			case 'right':
				// Anchor at label bottom-left.
				return `left: 100%; margin-left: ${GAP}px; top: ${pos}; transform: translateY(calc(-100% - ${PERP}px)); text-align: left;`;
			case 'top':
				// Reads bottom-to-top, label LEFT of wire. Anchor at bottom-right.
				return `bottom: 100%; margin-bottom: ${GAP}px; left: ${pos}; writing-mode: sideways-lr; transform: translateX(calc(-100% - ${PERP}px)); text-align: end;`;
			case 'bottom':
				// Reads top-to-bottom, label RIGHT of wire. Anchor at top-left
				// (= label's bottom-left if you tilt your head left to read).
				return `top: 100%; margin-top: ${GAP}px; left: ${pos}; writing-mode: sideways-rl; transform: translateX(${PERP}px); text-align: start;`;
		}
	}

	// Tooltip position for input handles (show tooltip away from node)
	function getInputTooltipPosition(): 'bottom' | 'left' | 'right' | 'top' {
		switch (rotation) {
			case 1: return 'top';    // inputs on top → tooltip above
			case 2: return 'right';  // inputs on right → tooltip to right
			case 3: return 'bottom'; // inputs on bottom → tooltip below
			default: return 'left';  // inputs on left → tooltip to left
		}
	}

	// Tooltip position for output handles (show tooltip away from node)
	function getOutputTooltipPosition(): 'bottom' | 'left' | 'right' | 'top' {
		switch (rotation) {
			case 1: return 'bottom'; // outputs on bottom → tooltip below
			case 2: return 'left';   // outputs on left → tooltip to left
			case 3: return 'top';    // outputs on top → tooltip above
			default: return 'right'; // outputs on right → tooltip to right
		}
	}

	// Handle mouse events for input handles. The hover tooltip is suppressed
	// when port labels are already shown — the label IS the name, no point
	// also popping a tooltip on top of it.
	function handleInputMouseEnter(event: MouseEvent, name: string, handleId: string) {
		hoveredHandle.set({ nodeId: id, handleId, color: nodeColor });
		if (!hasVisibleInputLabels) {
			showTooltip(name, event.currentTarget as HTMLElement, getInputTooltipPosition());
		}
	}

	// Handle mouse events for output handles
	function handleOutputMouseEnter(event: MouseEvent, name: string, handleId: string) {
		hoveredHandle.set({ nodeId: id, handleId, color: nodeColor });
		if (!hasVisibleOutputLabels) {
			showTooltip(name, event.currentTarget as HTMLElement, getOutputTooltipPosition());
		}
	}

	function handleMouseLeave() {
		hoveredHandle.set(null);
		hideTooltip();
	}
</script>

<!-- Port labels: rendered outside the block bounds so the block size
     stays the same whether labels are shown or not. The matching label
     for the currently-hovered handle picks up the node accent color. -->
{#if hasVisibleInputLabels}
	{#each inputs as port, i}
		<span
			class="port-label"
			class:hovered={$hoveredHandle?.handleId === port.id}
			style={portLabelStyle(true, i, inputs.length)}
		>
			{truncatePortLabel(inputName(port, i))}
		</span>
	{/each}
{/if}
{#if hasVisibleOutputLabels}
	{#each outputs as port, i}
		<span
			class="port-label"
			class:hovered={$hoveredHandle?.handleId === port.id}
			style={portLabelStyle(false, i, outputs.length)}
		>
			{truncatePortLabel(port.name)}
		</span>
	{/each}
{/if}

<!-- Input handles -->
{#key `${rotation}-${inputs.length}`}
	{#each inputs as port, i}
		<Handle
			type="target"
			position={inputPosition}
			id={port.id}
			style={isVertical ? `left: ${getPortPositionCalc(i, inputs.length)};` : `top: ${getPortPositionCalc(i, inputs.length)};`}
			class="handle handle-input"
			onmouseenter={(e) => handleInputMouseEnter(e, inputName(port, i), port.id)}
			onmouseleave={handleMouseLeave}
		/>
	{/each}
{/key}

<!-- Output handles -->
{#key `${rotation}-${outputs.length}`}
	{#each outputs as port, i}
		<Handle
			type="source"
			position={outputPosition}
			id={port.id}
			style={isVertical ? `left: ${getPortPositionCalc(i, outputs.length)};` : `top: ${getPortPositionCalc(i, outputs.length)};`}
			class="handle handle-output"
			onmouseenter={(e) => handleOutputMouseEnter(e, port.name, port.id)}
			onmouseleave={handleMouseLeave}
		/>
	{/each}
{/key}

<style>
	/* Port labels: rendered as absolutely-positioned spans on the .node
	 * container, sitting just outside the block edge next to their handle.
	 * Position math (which edge, perpendicular offset, text-align) is set
	 * inline by portLabelStyle() — only typography lives in CSS. */
	.port-label {
		position: absolute;
		font-size: 8px;
		line-height: 1;
		color: var(--text-muted);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		max-width: 64px;
		pointer-events: none;
		transition: color 0.12s;
	}

	/* Highlight labels in the node accent color when either:
	 *  - the block is selected, or
	 *  - a port handle is hovered (only that single label).
	 * The colour comes from --node-color set on the parent .node. */
	:global(.node.selected) .port-label,
	.port-label.hovered {
		color: var(--node-color, var(--accent));
		font-weight: 500;
	}
</style>
