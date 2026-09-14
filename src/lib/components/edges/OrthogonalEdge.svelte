<script module lang="ts">
	import type { PortInfo } from '$lib/stores/routing';

	// Module-level drag state - persists across component recreation
	interface DragState {
		edgeId: string;
		waypointId: string;
		lastSnappedPos: { x: number; y: number };
		getPortInfo: (nodeId: string, portIndex: number, isOutput: boolean) => PortInfo | null;
		cleanup: () => void;
	}

	let activeDrag: DragState | null = null;

	// Reactive view of the drag for rendering
	const dragView = $state<{ edgeId: string | null; waypointId: string | null }>({
		edgeId: null,
		waypointId: null
	});

	function setActiveDrag(drag: DragState | null): void {
		activeDrag = drag;
		dragView.edgeId = drag?.edgeId ?? null;
		dragView.waypointId = drag?.waypointId ?? null;
	}
</script>

<script lang="ts">
	import { BaseEdge, EdgeLabel, getSmoothStepPath, type EdgeProps, Position } from '@xyflow/svelte';
	import { routingStore } from '$lib/stores/routing';
	import { graphStore } from '$lib/stores/graph';
	import { edgeHighlights } from '$lib/stores/edgeHighlight';
	import { edgeLabelEdit, editEdgeLabel } from '$lib/stores/edgeLabelEdit.svelte';
	import { historyStore } from '$lib/stores/history';
	import { screenToFlow } from '$lib/utils/viewUtils';
	import { GRID_SIZE, EDGE_SOURCE_OFFSET, EDGE_TARGET_OFFSET, EDGE_CORNER_RADIUS } from '$lib/routing/constants';
	import InlineInput from '$lib/components/InlineInput.svelte';
	import { BUS_WIRE } from '$lib/constants/dimensions';
	import type { Direction, RouteResult } from '$lib/routing';
	import type { Waypoint } from '$lib/types/nodes';

	let {
		id,
		source,
		target,
		sourceX,
		sourceY,
		targetX,
		targetY,
		sourcePosition,
		targetPosition,
		style,
		selected,
		data
	}: EdgeProps = $props();

	/** Arrow angle when a fallback path enters the target handle */
	const ARRIVAL_ANGLE: Record<Position, number> = {
		[Position.Left]: 0,
		[Position.Right]: 180,
		[Position.Top]: 90,
		[Position.Bottom]: -90
	};

	/** Minimum distance of a segment midpoint handle from an existing waypoint */
	const MIN_DISTANCE_FROM_WAYPOINT = 20;

	/** Segments shorter than this get no midpoint handle */
	const MIN_SEGMENT_LENGTH = 30;

	// Convert SvelteFlow Position to routing Direction
	function positionToDirection(pos: Position): Direction {
		switch (pos) {
			case Position.Left: return 'left';
			case Position.Right: return 'right';
			case Position.Top: return 'up';
			case Position.Bottom: return 'down';
			default: return 'right';
		}
	}

	// Port info of this edge's endpoints, used when cleaning up waypoints after a drag
	function getPortInfo(nodeId: string, portIndex: number, isOutput: boolean): PortInfo | null {
		if (isOutput && nodeId === source) {
			return {
				position: { x: sourceX, y: sourceY },
				direction: positionToDirection(sourcePosition)
			};
		}
		if (!isOutput && nodeId === target) {
			return {
				position: { x: targetX, y: targetY },
				direction: positionToDirection(targetPosition)
			};
		}
		return null;
	}

	const isDragging = $derived(dragView.edgeId === id);
	const draggingWaypointId = $derived(isDragging ? dragView.waypointId : null);

	function snapToGrid(clientX: number, clientY: number): { x: number; y: number } {
		const flowPos = screenToFlow({ x: clientX, y: clientY });
		return {
			x: Math.round(flowPos.x / GRID_SIZE) * GRID_SIZE,
			y: Math.round(flowPos.y / GRID_SIZE) * GRID_SIZE
		};
	}

	// Drag a waypoint using document-level handlers and the module drag state
	function startWaypointDrag(waypointId: string, startPos: { x: number; y: number }) {
		const onMove = (e: PointerEvent) => {
			if (!activeDrag || activeDrag.edgeId !== id) return;
			e.stopPropagation();
			e.preventDefault();

			const snapped = snapToGrid(e.clientX, e.clientY);
			// Only update if the position actually changed on the grid
			if (snapped.x === activeDrag.lastSnappedPos.x && snapped.y === activeDrag.lastSnappedPos.y) return;
			activeDrag.lastSnappedPos = snapped;

			routingStore.moveWaypoint(activeDrag.edgeId, activeDrag.waypointId, snapped);
		};

		const removeListeners = () => {
			document.removeEventListener('pointermove', onMove, { capture: true });
			document.removeEventListener('pointerup', onUp, { capture: true });
		};

		const onUp = (e: PointerEvent) => {
			if (!activeDrag) return;
			e.stopPropagation();
			e.preventDefault();
			removeListeners();

			const dragState = activeDrag;
			setActiveDrag(null);

			historyStore.endDrag();
			routingStore.cleanupWaypoints(dragState.edgeId, dragState.getPortInfo);
		};

		setActiveDrag({
			edgeId: id,
			waypointId,
			lastSnappedPos: { ...startPos },
			getPortInfo,
			cleanup: removeListeners
		});

		historyStore.beginDrag();
		document.addEventListener('pointermove', onMove, { capture: true });
		document.addEventListener('pointerup', onUp, { capture: true });
	}

	function handleWaypointPointerDown(event: PointerEvent, waypoint: Waypoint) {
		event.stopPropagation();
		event.preventDefault();
		startWaypointDrag(waypoint.id, waypoint.position);
	}

	// Double-click to delete waypoint
	function handleWaypointDoubleClick(event: MouseEvent, waypoint: Waypoint) {
		event.stopPropagation();
		event.preventDefault();
		routingStore.removeUserWaypoint(id, waypoint.id);
	}

	// Route from the routing store, reactive for this connection only
	const routeResult = $derived(routingStore.route(id) ?? null);

	// Last usable orthogonal route; kept while a new route is pending or unavailable
	let lastValidRoute: RouteResult | null = null;
	const displayedRoute = $derived.by(() => {
		if (routeResult && routeResult.path.length >= 1 && !routeResult.isFallback) lastValidRoute = routeResult;
		return lastValidRoute;
	});

	// Highlight color when attached to the hovered handle or the selected node
	const highlightColor = $derived(edgeHighlights.get(id));

	/** Move a point along a handle's facing direction */
	function alongFacing(x: number, y: number, position: Position, distance: number): { x: number; y: number } {
		switch (position) {
			case Position.Right: return { x: x + distance, y };
			case Position.Left: return { x: x - distance, y };
			case Position.Bottom: return { x, y: y + distance };
			case Position.Top: return { x, y: y - distance };
			default: return { x, y };
		}
	}

	// Path ends at the handle tips: small inset at the source, room for the arrowhead at the target
	const adjustedSource = $derived(alongFacing(sourceX, sourceY, sourcePosition, -EDGE_SOURCE_OFFSET));
	const adjustedTarget = $derived(alongFacing(targetX, targetY, targetPosition, EDGE_TARGET_OFFSET));

	/**
	 * Build SVG path with rounded corners using quadratic bezier curves
	 */
	function buildRoundedPath(points: Array<{ x: number; y: number }>, radius: number): string {
		if (points.length < 2) return '';
		if (points.length === 2) {
			return `M ${points[0].x} ${points[0].y} L ${points[1].x} ${points[1].y}`;
		}

		let d = `M ${points[0].x} ${points[0].y}`;

		for (let i = 1; i < points.length - 1; i++) {
			const prev = points[i - 1];
			const curr = points[i];
			const next = points[i + 1];

			const distPrev = Math.hypot(curr.x - prev.x, curr.y - prev.y);
			const distNext = Math.hypot(next.x - curr.x, next.y - curr.y);

			// Clamp radius to half the shorter segment
			const r = Math.min(radius, distPrev / 2, distNext / 2);

			if (r < 0.5) {
				// Too short for rounding, just go to point
				d += ` L ${curr.x} ${curr.y}`;
				continue;
			}

			const dxPrev = (prev.x - curr.x) / distPrev;
			const dyPrev = (prev.y - curr.y) / distPrev;
			const dxNext = (next.x - curr.x) / distNext;
			const dyNext = (next.y - curr.y) / distNext;

			const startX = curr.x + dxPrev * r;
			const startY = curr.y + dyPrev * r;
			const endX = curr.x + dxNext * r;
			const endY = curr.y + dyNext * r;

			// Line to curve start, then quadratic bezier with corner as control point
			d += ` L ${startX} ${startY} Q ${curr.x} ${curr.y} ${endX} ${endY}`;
		}

		const last = points[points.length - 1];
		d += ` L ${last.x} ${last.y}`;

		return d;
	}

	// Rounded orthogonal path, or a smooth-step path while no route is available
	const path = $derived.by(() => {
		if (displayedRoute) {
			return buildRoundedPath([adjustedSource, ...displayedRoute.path, adjustedTarget], EDGE_CORNER_RADIUS);
		}
		return getSmoothStepPath({
			sourceX: adjustedSource.x,
			sourceY: adjustedSource.y,
			sourcePosition,
			targetX: adjustedTarget.x,
			targetY: adjustedTarget.y,
			targetPosition,
			borderRadius: 8
		})[0];
	});

	// Arrow at the end of the path, pointing along the last segment
	const endArrow = $derived.by(() => {
		const tip = adjustedTarget;
		if (displayedRoute) {
			const prev = displayedRoute.path[displayedRoute.path.length - 1];
			return { x: tip.x, y: tip.y, angle: Math.atan2(tip.y - prev.y, tip.x - prev.x) * (180 / Math.PI) };
		}
		return { x: tip.x, y: tip.y, angle: ARRIVAL_ANGLE[targetPosition] ?? 0 };
	});

	// User waypoints from the route result, or from the connection while no route exists yet
	const userWaypoints = $derived(
		(routeResult?.waypoints ?? (data as { waypoints?: Waypoint[] } | undefined)?.waypoints ?? []).filter(
			(w) => w.isUserWaypoint
		)
	);

	// Waypoint handles are visible when the edge is selected or being dragged
	const waypointsVisible = $derived(selected || isDragging);

	// Midpoint handles for adding waypoints, only computed while visible
	const segmentMidpoints = $derived.by(() => {
		if (!waypointsVisible || !displayedRoute) return [];

		const points = [adjustedSource, ...displayedRoute.path, adjustedTarget];
		const midpoints: Array<{ x: number; y: number; segmentIndex: number }> = [];
		for (let i = 0; i < points.length - 1; i++) {
			const p1 = points[i];
			const p2 = points[i + 1];
			if (Math.hypot(p2.x - p1.x, p2.y - p1.y) <= MIN_SEGMENT_LENGTH) continue;

			const x = (p1.x + p2.x) / 2;
			const y = (p1.y + p2.y) / 2;
			const nearWaypoint = userWaypoints.some(
				(wp) => Math.hypot(wp.position.x - x, wp.position.y - y) < MIN_DISTANCE_FROM_WAYPOINT
			);
			if (!nearWaypoint) midpoints.push({ x, y, segmentIndex: i });
		}
		return midpoints;
	});

	// Wires carrying a bus are drawn thicker
	const carriesBus = $derived(Boolean((data as { bus?: boolean } | undefined)?.bus));

	// Connection label, shown on the middle of the longest route segment
	const label = $derived((data as { label?: string } | undefined)?.label ?? '');
	const isEditingLabel = $derived(edgeLabelEdit.connectionId === id);

	const labelAnchor = $derived.by(() => {
		if (!label && !isEditingLabel) return null;
		const points = displayedRoute
			? [adjustedSource, ...displayedRoute.path, adjustedTarget]
			: [adjustedSource, adjustedTarget];
		let anchor = points[0];
		let longest = -1;
		for (let i = 0; i < points.length - 1; i++) {
			const length = Math.abs(points[i + 1].x - points[i].x) + Math.abs(points[i + 1].y - points[i].y);
			if (length > longest) {
				longest = length;
				anchor = { x: (points[i].x + points[i + 1].x) / 2, y: (points[i].y + points[i + 1].y) / 2 };
			}
		}
		return anchor;
	});

	function handleEdgeDoubleClick(event: MouseEvent) {
		event.stopPropagation();
		editEdgeLabel(id);
	}

	function commitLabel(text: string) {
		if (edgeLabelEdit.connectionId !== id) return;
		editEdgeLabel(null);
		if (text.trim() === label) return;
		historyStore.mutate(() => graphStore.updateConnectionLabel(id, text));
	}

	// Segment drag creates a waypoint, then drags it
	function handleSegmentPointerDown(event: PointerEvent, segmentIndex: number) {
		event.stopPropagation();
		event.preventDefault();

		const snappedPos = snapToGrid(event.clientX, event.clientY);
		const insertIndex = countWaypointsBeforeSegment(segmentIndex, userWaypoints);
		const waypointId = routingStore.addUserWaypointAtIndex(id, snappedPos, insertIndex);
		if (waypointId) startWaypointDrag(waypointId, snappedPos);
	}

	/**
	 * Find the insert index for a new waypoint created on the given segment.
	 * Uses cumulative path distance to determine which existing waypoints
	 * are before vs after the segment.
	 */
	function countWaypointsBeforeSegment(segmentIndex: number, waypoints: Waypoint[]): number {
		if (waypoints.length === 0 || !displayedRoute) return 0;

		const points = [adjustedSource, ...displayedRoute.path, adjustedTarget];

		const cumDist: number[] = [0];
		for (let i = 1; i < points.length; i++) {
			cumDist.push(cumDist[i - 1] + Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y));
		}

		const segMidDist = (cumDist[segmentIndex] + cumDist[segmentIndex + 1]) / 2;

		// A waypoint counts as before the segment if its closest path point lies before the segment midpoint
		let count = 0;
		for (const wp of waypoints) {
			let closestPointDist = Infinity;
			let closestCumDist = 0;
			for (let i = 0; i < points.length; i++) {
				const dist = Math.hypot(points[i].x - wp.position.x, points[i].y - wp.position.y);
				if (dist < closestPointDist) {
					closestPointDist = dist;
					closestCumDist = cumDist[i];
				}
			}
			if (closestCumDist < segMidDist) count++;
		}
		return count;
	}
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<g
	class:highlighted={highlightColor !== undefined}
	class:bus-wire={carriesBus}
	style="--bus-wire-width: {BUS_WIRE.strokeWidth}px;{highlightColor !== undefined ? ` --highlight-color: ${highlightColor};` : ''}"
	ondblclick={handleEdgeDoubleClick}
>
	<BaseEdge {id} {path} {style} />

	<!-- Waypoint handles (always in DOM, visibility via style) -->
	<g
		class="waypoint-group"
		style="opacity: {waypointsVisible ? 1 : 0}; pointer-events: {waypointsVisible ? 'all' : 'none'};"
	>
		{#each userWaypoints as waypoint (waypoint.id)}
			<!-- svelte-ignore a11y_no_static_element_interactions -->
			<circle
				cx={waypoint.position.x}
				cy={waypoint.position.y}
				r="4"
				class="waypoint-marker"
				class:dragging={isDragging && draggingWaypointId === waypoint.id}
				onpointerdown={(e) => handleWaypointPointerDown(e, waypoint)}
				ondblclick={(e) => handleWaypointDoubleClick(e, waypoint)}
			/>
		{/each}

		<!-- Segment midpoint indicators (ghost waypoints) -->
		{#each segmentMidpoints as midpoint (midpoint.segmentIndex)}
			<circle
				cx={midpoint.x}
				cy={midpoint.y}
				r="3"
				class="segment-midpoint"
				onpointerdown={(e) => handleSegmentPointerDown(e, midpoint.segmentIndex)}
			/>
		{/each}
	</g>

	<!-- Arrow at the end - offset forward 5px to reach target handle tip -->
	<g transform="translate({endArrow.x}, {endArrow.y}) rotate({endArrow.angle}) translate(5, 0)">
		<path
			d="M -5 -2.5 L -1 -0.5 Q 0 0 -1 0.5 L -5 2.5 Q -6 3 -6 2 L -6 -2 Q -6 -3 -5 -2.5 Z"
			class="edge-arrow"
			class:selected
			class:highlighted={highlightColor !== undefined}
		/>
	</g>

	{#if label && !isEditingLabel && labelAnchor}
		<text
			x={labelAnchor.x}
			y={labelAnchor.y}
			class="edge-label"
			class:selected
			class:highlighted={highlightColor !== undefined}>{label}</text
		>
	{/if}
</g>

{#if isEditingLabel && labelAnchor}
	<EdgeLabel x={labelAnchor.x} y={labelAnchor.y} transparent>
		<InlineInput value={label} placeholder="Label" onCommit={commitLabel} onCancel={() => editEdgeLabel(null)} />
	</EdgeLabel>
{/if}

<style>
	.edge-arrow {
		fill: var(--edge);
		stroke: none;
		transition:
			fill 0.15s ease,
			transform 0.15s ease;
	}

	.edge-arrow.selected {
		fill: var(--accent);
		transform: scale(1.3);
	}

	.edge-arrow.highlighted {
		fill: var(--highlight-color, var(--accent));
	}

	:global(.svelte-flow__edge:hover) .edge-arrow {
		fill: var(--accent);
	}

	.bus-wire :global(.svelte-flow__edge-path) {
		stroke-width: var(--bus-wire-width);
	}

	/* Highlight the edge path when handle is hovered */
	.highlighted :global(.svelte-flow__edge-path) {
		stroke: var(--highlight-color, var(--accent)) !important;
	}

	/* Connection label with a halo in the canvas color, readable on top of wires.
	 * Pointer events pass through to the wire, so hovering the label hovers the edge. */
	.edge-label {
		font-family: var(--font-ui);
		font-size: var(--font-xs);
		fill: var(--text-muted);
		stroke: var(--surface);
		stroke-width: 3px;
		stroke-linejoin: round;
		paint-order: stroke;
		text-anchor: middle;
		dominant-baseline: central;
		pointer-events: none;
		transition: fill 0.15s ease;
	}

	:global(.svelte-flow__edge:hover) .edge-label,
	.edge-label.selected {
		fill: var(--accent);
	}

	.edge-label.highlighted {
		fill: var(--highlight-color, var(--accent));
	}

	/* Waypoint group - visibility controlled by inline styles */
	.waypoint-group {
		transition: opacity 0.1s ease;
	}

	/* Waypoint markers (SVG circles) */
	.waypoint-marker {
		fill: var(--surface);
		stroke: var(--accent);
		stroke-width: 1.5;
		cursor: grab;
		touch-action: none;
		transition: fill 0.15s ease;
	}

	.waypoint-marker.dragging {
		cursor: grabbing;
		stroke-width: 2;
		fill: var(--accent);
	}

	/* Segment midpoint indicators (SVG circles) */
	.segment-midpoint {
		fill: var(--surface);
		stroke: var(--edge);
		stroke-width: 1;
		cursor: grab;
		touch-action: none;
		opacity: 0.5;
		transition:
			opacity 0.15s ease,
			stroke 0.15s ease;
	}

	.segment-midpoint:hover {
		opacity: 1;
		stroke: var(--accent);
	}
</style>
