<script lang="ts">
	import type { Snippet } from 'svelte';
	import { Handle, Position } from '@xyflow/svelte';
	import type { PortDirection, PortInstance } from '$lib/nodes/types';
	import { graphStore } from '$lib/stores/graph';
	import { historyStore } from '$lib/stores/history';
	import { hoveredHandle } from '$lib/stores/hoveredHandle';
	import { showTooltip, hideTooltip } from '$lib/components/Tooltip.svelte';
	import { getPortPositionCalc } from '$lib/constants/dimensions';
	import { truncatePortLabel } from '$lib/utils/portLabels';

	/**
	 * Ports of a block node: handles, port labels and the +/- controls for blocks
	 * with a variable port count. Sits inside the node element, whose edges
	 * everything is positioned against.
	 */
	interface Props {
		id: string;
		inputs: PortInstance[];
		outputs: PortInstance[];
		rotation: number;
		nodeColor: string;
		selected: boolean;
		showInputLabels: boolean;
		showOutputLabels: boolean;
		/** Inputs and outputs can be added and removed while the block is selected */
		dynamicInputs?: boolean;
		dynamicOutputs?: boolean;
		minInputs?: number;
		minOutputs?: number;
		/** Names shown for the inputs instead of the port names, e.g. derived signal names */
		inputNames?: string[];
		/** Indices of ports carrying a bus, drawn with the bus handle */
		busInputs?: number[];
		busOutputs?: number[];
		/** Labels are signal names: styled like connection labels and editable with a double-click */
		signalLabels?: boolean;
		/** Label being edited as "input:0" or "output:1", rendered by labelEditor */
		editingLabel?: string | null;
		onLabelEdit?: (direction: PortDirection, index: number) => void;
		labelEditor?: Snippet<[PortDirection, number]>;
	}

	let {
		id,
		inputs,
		outputs,
		rotation,
		nodeColor,
		selected,
		showInputLabels,
		showOutputLabels,
		dynamicInputs = false,
		dynamicOutputs = false,
		minInputs = 1,
		minOutputs = 1,
		inputNames,
		busInputs,
		busOutputs,
		signalLabels = false,
		editingLabel = null,
		onLabelEdit,
		labelEditor
	}: Props = $props();

	const isEditing = (direction: PortDirection, index: number) =>
		labelEditor !== undefined && editingLabel === `${direction}:${index}`;

	function handleLabelDoubleClick(event: MouseEvent, direction: PortDirection, index: number) {
		if (!onLabelEdit) return;
		event.stopPropagation();
		onLabelEdit(direction, index);
	}

	// Actual visibility: setting is ON and ports exist (single source of truth)
	const hasVisibleInputLabels = $derived(showInputLabels && inputs.length > 0);
	const hasVisibleOutputLabels = $derived(showOutputLabels && outputs.length > 0);

	const inputName = (port: PortInstance, index: number) => inputNames?.[index] ?? port.name;

	const handleClass = (direction: 'input' | 'output', index: number) => {
		const bus = (direction === 'input' ? busInputs : busOutputs)?.includes(index);
		return `handle handle-${direction}${bus ? ' handle-bus' : ''}`;
	};

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

	// Port count controls; removal respects the minimum port count
	function changePorts(event: MouseEvent, change: () => void) {
		event.stopPropagation();
		historyStore.mutate(change);
	}
</script>

<!-- Port labels: rendered outside the block bounds so the block size
     stays the same whether labels are shown or not. The matching label
     for the currently-hovered handle picks up the node accent color. -->
{#if hasVisibleInputLabels}
	{#each inputs as port, i}
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<span
			class="port-label"
			class:signal={signalLabels}
			class:editing={isEditing('input', i)}
			class:nodrag={isEditing('input', i)}
			class:hovered={$hoveredHandle?.handleId === port.id}
			style={portLabelStyle(true, i, inputs.length)}
			ondblclick={(e) => handleLabelDoubleClick(e, 'input', i)}
		>
			{#if isEditing('input', i)}
				{@render labelEditor?.('input', i)}
			{:else}
				{truncatePortLabel(inputName(port, i))}
			{/if}
		</span>
	{/each}
{/if}
{#if hasVisibleOutputLabels}
	{#each outputs as port, i}
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<span
			class="port-label"
			class:signal={signalLabels}
			class:editing={isEditing('output', i)}
			class:nodrag={isEditing('output', i)}
			class:hovered={$hoveredHandle?.handleId === port.id}
			style={portLabelStyle(false, i, outputs.length)}
			ondblclick={(e) => handleLabelDoubleClick(e, 'output', i)}
		>
			{#if isEditing('output', i)}
				{@render labelEditor?.('output', i)}
			{:else}
				{truncatePortLabel(port.name)}
			{/if}
		</span>
	{/each}
{/if}

<!-- Port controls for dynamic inputs (only show when selected) -->
{#if dynamicInputs && selected}
	<div class="port-controls" class:port-controls-left={rotation === 0} class:port-controls-top={rotation === 1} class:port-controls-right={rotation === 2} class:port-controls-bottom={rotation === 3}>
		<button class="port-btn" onclick={(e) => changePorts(e, () => graphStore.addInputPort(id))} ondblclick={(e) => e.stopPropagation()} title="Add input">+</button>
		<button class="port-btn" onclick={(e) => changePorts(e, () => graphStore.removeInputPort(id))} ondblclick={(e) => e.stopPropagation()} disabled={inputs.length <= minInputs} title="Remove input">-</button>
	</div>
{/if}

<!-- Port controls for dynamic outputs (only show when selected) -->
{#if dynamicOutputs && selected}
	<div class="port-controls" class:port-controls-right={rotation === 0} class:port-controls-bottom={rotation === 1} class:port-controls-left={rotation === 2} class:port-controls-top={rotation === 3}>
		<button class="port-btn" onclick={(e) => changePorts(e, () => graphStore.addOutputPort(id))} ondblclick={(e) => e.stopPropagation()} title="Add output">+</button>
		<button class="port-btn" onclick={(e) => changePorts(e, () => graphStore.removeOutputPort(id))} ondblclick={(e) => e.stopPropagation()} disabled={outputs.length <= minOutputs} title="Remove output">-</button>
	</div>
{/if}

<!-- Input handles -->
{#key `${rotation}-${inputs.length}`}
	{#each inputs as port, i}
		<Handle
			type="target"
			position={inputPosition}
			id={port.id}
			style={isVertical ? `left: ${getPortPositionCalc(i, inputs.length)};` : `top: ${getPortPositionCalc(i, inputs.length)};`}
			class={handleClass('input', i)}
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
			class={handleClass('output', i)}
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

	/* Signal names on bus blocks look like connection labels: UI font with a
	 * halo in the canvas color. They take pointer events for the double-click. */
	.port-label.signal {
		font-family: var(--font-ui);
		font-size: var(--font-xs);
		font-weight: 400;
		text-shadow: 0 0 2px var(--surface), 0 0 2px var(--surface), 0 0 2px var(--surface);
		pointer-events: auto;
		cursor: text;
	}

	.port-label.editing {
		max-width: none;
		overflow: visible;
		text-shadow: none;
	}

	/* Port controls (+/- buttons) */
	.port-controls {
		position: absolute;
		display: flex;
		gap: 2px;
		z-index: 10;
	}

	.port-controls-left {
		left: -24px;
		top: 50%;
		transform: translateY(-50%);
		flex-direction: column;
	}

	.port-controls-right {
		right: -24px;
		top: 50%;
		transform: translateY(-50%);
		flex-direction: column;
	}

	.port-controls-top {
		top: -24px;
		left: 50%;
		transform: translateX(-50%);
		flex-direction: row;
	}

	.port-controls-bottom {
		bottom: -24px;
		left: 50%;
		transform: translateX(-50%);
		flex-direction: row;
	}

	.port-btn {
		width: 16px;
		height: 16px;
		padding: 0;
		border: 1px solid var(--node-color);
		border-radius: var(--radius-sm);
		background: var(--surface-raised);
		color: var(--node-color);
		font-size: 12px;
		font-weight: 600;
		line-height: 1;
		cursor: pointer;
		display: flex;
		align-items: center;
		justify-content: center;
	}

	.port-btn:hover:not(:disabled) {
		background: var(--node-color);
		color: var(--surface-raised);
	}

	.port-btn:disabled {
		opacity: 0.3;
		cursor: not-allowed;
	}

	/* Ports carrying a bus: the same arrow as other ports with a heavier outline,
	 * matching the thicker bus wire. Like other ports it fills on hover and selection. */
	:global(.node .svelte-flow__handle.handle-bus::after) {
		inset: 1.5px;
	}

	/* Inner cutouts, 1.5px inside the outer arrow */
	:global(.node[data-rotation="0"] .svelte-flow__handle.handle-bus::after) {
		clip-path: path('M 0.6 0 L 3.5 0 Q 3.9 0 4.2 0.3 L 6.1 2.2 Q 6.4 2.5 6.1 2.8 L 4.2 4.7 Q 3.9 5 3.5 5 L 0.6 5 Q 0 5 0 4.4 L 0 0.6 Q 0 0 0.6 0 Z');
	}

	:global(.node[data-rotation="1"] .svelte-flow__handle.handle-bus::after) {
		clip-path: path('M 0 0.6 L 0 3.5 Q 0 3.9 0.3 4.2 L 2.2 6.1 Q 2.5 6.4 2.8 6.1 L 4.7 4.2 Q 5 3.9 5 3.5 L 5 0.6 Q 5 0 4.4 0 L 0.6 0 Q 0 0 0 0.6 Z');
	}

	:global(.node[data-rotation="2"] .svelte-flow__handle.handle-bus::after) {
		clip-path: path('M 6.4 0 L 3.5 0 Q 3.1 0 2.8 0.3 L 0.9 2.2 Q 0.6 2.5 0.9 2.8 L 2.8 4.7 Q 3.1 5 3.5 5 L 6.4 5 Q 7 5 7 4.4 L 7 0.6 Q 7 0 6.4 0 Z');
	}

	:global(.node[data-rotation="3"] .svelte-flow__handle.handle-bus::after) {
		clip-path: path('M 0 6.4 L 0 3.5 Q 0 3.1 0.3 2.8 L 2.2 0.9 Q 2.5 0.6 2.8 0.9 L 4.7 2.8 Q 5 3.1 5 3.5 L 5 6.4 Q 5 7 4.4 7 L 0.6 7 Q 0 7 0 6.4 Z');
	}
</style>
