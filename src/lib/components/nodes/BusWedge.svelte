<script lang="ts">
	import { BUS } from '$lib/constants/dimensions';
	import { roundedPolygonPath } from '$lib/utils/svgPath';

	/**
	 * Bus Creator or Bus Selector symbol, shared by the canvas and the library.
	 * A trapezoid with rounded corners: the wide side carries the separate
	 * signals, the narrow side the bus. The narrow side is set in by the same
	 * amount at any length, so the angles never change.
	 */
	interface Props {
		creator: boolean;
		/** Size along the ports in pixels */
		length: number;
		/** Quarter turns, like block rotation */
		rotation?: number;
		selected?: boolean;
	}

	let { creator, length, rotation = 0, selected = false }: Props = $props();

	const vertical = $derived(rotation === 1 || rotation === 3);

	// Trapezoid in the unrotated frame, wide side left for a creator and right for a selector
	const shape = $derived.by(() => {
		const w = BUS.blockWidth;
		const inset = BUS.wedgeInset;
		const corners: [number, number][] = creator
			? [[0, 0], [w, inset], [w, length - inset], [0, length]]
			: [[0, inset], [w, 0], [w, length], [0, length - inset]];
		return roundedPolygonPath(corners, BUS.cornerRadius);
	});

	// Turn the unrotated frame into the box: the input side moves like block inputs do
	const frame = $derived.by(() => {
		switch (rotation) {
			case 1: return `translate(${length}, 0) rotate(90)`;
			case 2: return `translate(${BUS.blockWidth}, ${length}) rotate(180)`;
			case 3: return `translate(0, ${BUS.blockWidth}) rotate(270)`;
			default: return undefined;
		}
	});
</script>

<svg
	class="bus-wedge"
	class:selected
	width={vertical ? length : BUS.blockWidth}
	height={vertical ? BUS.blockWidth : length}
>
	<g transform={frame}>
		<path class="halo" d={shape} />
		<path class="body" d={shape} />
	</g>
</svg>

<style>
	.bus-wedge {
		display: block;
		overflow: visible;
	}

	.body {
		fill: var(--surface-raised);
		stroke: var(--edge);
		stroke-width: 1;
		stroke-linejoin: round;
		transition: stroke 0.15s ease;
	}

	/* Selection ring like the block box-shadow: a wide translucent stroke behind the body */
	.halo {
		fill: none;
		stroke: transparent;
		stroke-width: 5;
		stroke-linejoin: round;
	}

	.selected .body {
		stroke: var(--node-color, var(--accent));
	}

	.selected .halo {
		stroke: color-mix(in srgb, var(--node-color, var(--accent)) 25%, transparent);
	}
</style>
