<script lang="ts">
	import { useUpdateNodeInternals } from '@xyflow/svelte';
	import type { NodeInstance } from '$lib/nodes';
	import { NODE_TYPES } from '$lib/constants/nodeTypes';
	import { BUS, busBlockDimensions } from '$lib/constants/dimensions';
	import { openNodeDialog } from '$lib/stores/nodeDialog';
	import { selectedNodeHighlight } from '$lib/stores/hoveredHandle';
	import { busCreatorSignals } from '$lib/stores/busView.svelte';
	import { showTooltip, hideTooltip } from '$lib/components/Tooltip.svelte';
	import NodePorts from './NodePorts.svelte';

	/**
	 * Bus Creator and Bus Selector drawn as a narrow wedge instead of a block.
	 * The wide side carries the separate signals, the narrow side the bus.
	 * Signal ports are always labeled; the block name shows on hover.
	 */
	interface Props {
		id: string;
		data: NodeInstance;
		selected?: boolean;
	}

	let { id, data, selected = false }: Props = $props();

	const updateNodeInternals = useUpdateNodeInternals();

	const rotation = $derived((data.params?.['_rotation'] as number) || 0);
	const isCreator = $derived(data.type === NODE_TYPES.BUS_CREATOR);
	const size = $derived(busBlockDimensions(data.inputs.length, data.outputs.length, rotation));
	const nodeColor = $derived(data.color || 'var(--accent)');

	// Wedge in the unrotated frame, wide side left for a creator and right for a selector
	const length = $derived(Math.max(size.width, size.height));
	const wedge = $derived.by(() => {
		const w = BUS.blockWidth;
		const inset = (length - BUS.narrowSide) / 2;
		const corners = isCreator
			? [[0, 0], [w, inset], [w, length - inset], [0, length]]
			: [[0, inset], [w, 0], [w, length], [0, length - inset]];
		return corners.map(([x, y]) => `${x},${y}`).join(' ');
	});

	// Turn the unrotated frame into the node box: the input side moves like block inputs do
	const frame = $derived.by(() => {
		switch (rotation) {
			case 1: return `translate(${length}, 0) rotate(90)`;
			case 2: return `translate(${BUS.blockWidth}, ${length}) rotate(180)`;
			case 3: return `translate(0, ${BUS.blockWidth}) rotate(270)`;
			default: return undefined;
		}
	});

	// Re-measure handles when the wedge changes size or orientation
	$effect(() => {
		void size;
		updateNodeInternals(id);
	});

	// Highlight connected edges when selected, like blocks do
	$effect(() => {
		if (selected) {
			selectedNodeHighlight.set({ nodeId: id, color: nodeColor });
		} else {
			selectedNodeHighlight.update((current) => (current?.nodeId === id ? null : current));
		}
	});

	let body = $state<HTMLDivElement | null>(null);

	function handleMouseEnter() {
		if (body) showTooltip(data.name, body, rotation === 1 || rotation === 3 ? 'right' : 'top');
	}
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
	bind:this={body}
	class="node bus-block"
	class:selected
	data-rotation={rotation}
	style="width: {size.width}px; height: {size.height}px; --node-color: {nodeColor};"
	ondblclick={(e) => {
		e.stopPropagation();
		openNodeDialog(id);
	}}
	onmouseenter={handleMouseEnter}
	onmouseleave={hideTooltip}
>
	<svg class="wedge" width={size.width} height={size.height}>
		<g transform={frame}>
			<polygon class="wedge-halo" points={wedge} />
			<polygon class="wedge-body" points={wedge} />
		</g>
	</svg>

	<NodePorts
		{id}
		inputs={data.inputs}
		outputs={data.outputs}
		{rotation}
		{nodeColor}
		showInputLabels={isCreator}
		showOutputLabels={!isCreator}
		inputNames={isCreator ? busCreatorSignals.get(id) : undefined}
	/>
</div>

<style>
	.bus-block {
		position: relative;
	}

	.wedge {
		position: absolute;
		inset: 0;
		overflow: visible;
	}

	.wedge-body {
		fill: var(--surface-raised);
		stroke: var(--edge);
		stroke-width: 1;
		stroke-linejoin: round;
		transition: stroke 0.15s ease;
	}

	/* Selection ring like the block box-shadow: a wide translucent stroke behind the body */
	.wedge-halo {
		fill: none;
		stroke: transparent;
		stroke-width: 5;
		stroke-linejoin: round;
	}

	.bus-block.selected .wedge-body {
		stroke: var(--node-color);
	}

	.bus-block.selected .wedge-halo {
		stroke: color-mix(in srgb, var(--node-color) 25%, transparent);
	}
</style>
