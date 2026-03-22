<script lang="ts">
	import { BaseEdge, Position, getSmoothStepPath, type EdgeProps } from '@xyflow/svelte';
	import { hoveredHandle, selectedNodeHighlight } from '$lib/stores/hoveredHandle';
	import { branchDragStore, type BranchSegmentOrientation } from '$lib/stores/branchDrag';
	import { graphStore } from '$lib/stores/graph';
	import { HANDLE_ID } from '$lib/constants/handles';
	import { JUNCTION } from '$lib/constants/dimensions';
	import { getAcausalJunctionType, isAcausalJunctionNodeType } from '$lib/nodes/registry';
	import { flowToScreen, screenToFlow } from '$lib/utils/viewUtils';
	import { onDestroy } from 'svelte';

	let {
		id,
		source,
		target,
		sourceHandleId,
		targetHandleId,
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

	// Domain color from edge data (set in toFlowEdge)
	const domainColor = $derived((data as Record<string, unknown>)?.domainColor as string | undefined);
	const domain = $derived((data as Record<string, unknown>)?.domain as string | undefined);
	let connections = $state<
		Array<{
			sourceNodeId: string;
			sourcePortIndex: number;
			targetNodeId: string;
			targetPortIndex: number;
			kind?: 'causal' | 'acausal';
		}>
	>([]);
	const unsubscribeConnections = graphStore.connections.subscribe((value) => {
		connections = value;
	});

	// Check if this edge is connected to the hovered handle
	let hovered = $state<{ nodeId: string; handleId: string; color?: string } | null>(null);
	const unsubscribeHovered = hoveredHandle.subscribe((h) => (hovered = h));

	// Check if this edge is connected to a selected node
	let selectedNode = $state<{ nodeId: string; color?: string } | null>(null);
	const unsubscribeSelected = selectedNodeHighlight.subscribe((s) => (selectedNode = s));

	onDestroy(() => {
		unsubscribeHovered();
		unsubscribeSelected();
		unsubscribeConnections();
	});

	const isHoverHighlighted = $derived(() => {
		if (!hovered) return false;
		return (
			(source === hovered.nodeId && sourceHandleId === hovered.handleId) ||
			(target === hovered.nodeId && targetHandleId === hovered.handleId)
		);
	});

	const isSelectionHighlighted = $derived(() => {
		if (!selectedNode) return false;
		return source === selectedNode.nodeId || target === selectedNode.nodeId;
	});

	const isHighlighted = $derived(() => isHoverHighlighted() || isSelectionHighlighted());
	const SELECTED_EDGE_COLOR = '#4da3ff';
	const HOVER_EDGE_COLOR = '#ffb347';

	const edgeColor = $derived(() => {
		if (selected) {
			return SELECTED_EDGE_COLOR;
		}
		if (isHoverHighlighted()) {
			return HOVER_EDGE_COLOR;
		}
		if (isSelectionHighlighted()) {
			return domainColor || 'var(--accent)';
		}
		return domainColor || 'var(--edge)';
	});

	const endpointInset = 2;
	const adjustedSource = $derived(() => {
		let x = sourceX;
		let y = sourceY;
		if (sourcePosition === 'right') x -= endpointInset;
		else if (sourcePosition === 'left') x += endpointInset;
		else if (sourcePosition === 'bottom') y -= endpointInset;
		else if (sourcePosition === 'top') y += endpointInset;
		return { x, y };
	});

	const adjustedTarget = $derived(() => {
		let x = targetX;
		let y = targetY;
		if (targetPosition === 'right') x -= endpointInset;
		else if (targetPosition === 'left') x += endpointInset;
		else if (targetPosition === 'bottom') y -= endpointInset;
		else if (targetPosition === 'top') y += endpointInset;
		return { x, y };
	});

	const pathData = $derived(() => {
		const src = adjustedSource();
		const tgt = adjustedTarget();
		const [edgePath] = getSmoothStepPath({
			sourceX: src.x,
			sourceY: src.y,
			sourcePosition,
			targetX: tgt.x,
			targetY: tgt.y,
			targetPosition,
			borderRadius: 8
		});
		return edgePath;
	});

	function countAcausalPortConnections(nodeId: string, portIndex: number): number {
		return connections.filter((connection) =>
			connection.kind === 'acausal' &&
			(
				(connection.sourceNodeId === nodeId && connection.sourcePortIndex === portIndex) ||
				(connection.targetNodeId === nodeId && connection.targetPortIndex === portIndex)
			)
		).length;
	}

	const sourcePortIndex = $derived(
		sourceHandleId ? HANDLE_ID.parseIndex(sourceHandleId, 'acausal') : null
	);
	const targetPortIndex = $derived(
		targetHandleId ? HANDLE_ID.parseIndex(targetHandleId, 'acausal') : null
	);

	const showSourceJunction = $derived(
		sourcePortIndex !== null && countAcausalPortConnections(source, sourcePortIndex) > 1
	);
	const showTargetJunction = $derived(
		targetPortIndex !== null && countAcausalPortConnections(target, targetPortIndex) > 1
	);

	interface PendingBranchGesture {
		clientX: number;
		clientY: number;
		domain: string;
		domainColor?: string;
		junctionType: string;
		sourceNodeId: string;
		sourcePortIndex: number;
		targetNodeId: string;
		targetPortIndex: number;
		junctionFlowPosition: { x: number; y: number };
		sourceJunctionPort: number;
		targetJunctionPort: number;
		segmentOrientation: BranchSegmentOrientation;
		reuseJunctionNodeId: string | null;
		reuseJunctionFlowPosition: { x: number; y: number } | null;
		reuseJunctionScreenPosition: { x: number; y: number } | null;
		pointerId: number;
		activated: boolean;
	}

	let pendingBranchGesture = $state<PendingBranchGesture | null>(null);
	const BRANCH_DRAG_THRESHOLD = 6;
	const EXISTING_JUNCTION_REUSE_THRESHOLD = 10;

	function getOccupiedJunctionPorts(nodeId: string): Set<number> {
		const occupied = new Set<number>();
		for (const connection of connections) {
			if (connection.kind !== 'acausal') continue;
			if (connection.sourceNodeId === nodeId) occupied.add(connection.sourcePortIndex);
			if (connection.targetNodeId === nodeId) occupied.add(connection.targetPortIndex);
		}
		return occupied;
	}

	function getReusableJunctionCandidate(clientX: number, clientY: number): {
		junctionNodeId: string;
		junctionFlowPosition: { x: number; y: number };
		junctionScreenPosition: { x: number; y: number };
	} | null {
		const candidates: Array<{
			junctionNodeId: string;
			junctionFlowPosition: { x: number; y: number };
			junctionScreenPosition: { x: number; y: number };
			distance: number;
		}> = [];

		for (const nodeId of [source, target]) {
			const node = graphStore.getNode(nodeId);
			if (!node || !isAcausalJunctionNodeType(node.type)) continue;

			const occupiedPorts = getOccupiedJunctionPorts(nodeId);
			if (occupiedPorts.size >= 4) continue;

			const flowPosition = { x: node.position.x, y: node.position.y };
			const screenPosition = flowToScreen(flowPosition);
			candidates.push({
				junctionNodeId: nodeId,
				junctionFlowPosition: flowPosition,
				junctionScreenPosition: screenPosition,
				distance: Math.hypot(screenPosition.x - clientX, screenPosition.y - clientY)
			});
		}

		if (candidates.length === 0) return null;
		candidates.sort((a, b) => a.distance - b.distance);
		const best = candidates[0];
		if (best.distance > EXISTING_JUNCTION_REUSE_THRESHOLD) return null;
		return {
			junctionNodeId: best.junctionNodeId,
			junctionFlowPosition: best.junctionFlowPosition,
			junctionScreenPosition: best.junctionScreenPosition
		};
	}

	function getFallbackJunctionPlacement(): {
		sourceJunctionPort: number;
		targetJunctionPort: number;
		segmentOrientation: BranchSegmentOrientation;
	} {
		if (sourcePosition === 'top' || sourcePosition === 'bottom') {
			return sourcePosition === 'bottom'
				? { sourceJunctionPort: 2, targetJunctionPort: 3, segmentOrientation: 'vertical' }
				: { sourceJunctionPort: 3, targetJunctionPort: 2, segmentOrientation: 'vertical' };
		}
		return sourcePosition === 'right'
			? { sourceJunctionPort: 0, targetJunctionPort: 1, segmentOrientation: 'horizontal' }
			: { sourceJunctionPort: 1, targetJunctionPort: 0, segmentOrientation: 'horizontal' };
	}

	function getJunctionPlacementForClick(clickX: number, clickY: number): {
		sourceJunctionPort: number;
		targetJunctionPort: number;
		segmentOrientation: BranchSegmentOrientation;
	} {
		const path = pathData();
		if (!path) return getFallbackJunctionPlacement();

		const svgPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
		svgPath.setAttribute('d', path);

		const totalLength = svgPath.getTotalLength();
		if (totalLength <= 0) return getFallbackJunctionPlacement();

		const sampleStep = Math.max(2, Math.min(6, totalLength / 48));
		let closestLength = 0;
		let closestDistance = Number.POSITIVE_INFINITY;

		for (let length = 0; length <= totalLength; length += sampleStep) {
			const point = svgPath.getPointAtLength(length);
			const distance = Math.hypot(point.x - clickX, point.y - clickY);
			if (distance < closestDistance) {
				closestDistance = distance;
				closestLength = length;
			}
		}

		if (closestLength !== totalLength) {
			const endPoint = svgPath.getPointAtLength(totalLength);
			const endDistance = Math.hypot(endPoint.x - clickX, endPoint.y - clickY);
			if (endDistance < closestDistance) {
				closestDistance = endDistance;
				closestLength = totalLength;
			}
		}

		const tangentOffset = Math.max(2, Math.min(8, totalLength / 24));
		const before = svgPath.getPointAtLength(Math.max(0, closestLength - tangentOffset));
		const after = svgPath.getPointAtLength(Math.min(totalLength, closestLength + tangentOffset));
		const dx = after.x - before.x;
		const dy = after.y - before.y;

		if (Math.abs(dx) >= Math.abs(dy)) {
			return dx >= 0
				? { sourceJunctionPort: 0, targetJunctionPort: 1, segmentOrientation: 'horizontal' }
				: { sourceJunctionPort: 1, targetJunctionPort: 0, segmentOrientation: 'horizontal' };
		}

		return dy >= 0
			? { sourceJunctionPort: 2, targetJunctionPort: 3, segmentOrientation: 'vertical' }
			: { sourceJunctionPort: 3, targetJunctionPort: 2, segmentOrientation: 'vertical' };
	}

	function clearPendingBranchGesture(): void {
		pendingBranchGesture = null;
		window.removeEventListener('pointermove', handlePendingBranchPointerMove, true);
		window.removeEventListener('pointerup', handlePendingBranchPointerUp, true);
		window.removeEventListener('contextmenu', handlePendingBranchContextMenu, true);
	}

	function handlePendingBranchContextMenu(event: MouseEvent): void {
		if (pendingBranchGesture?.activated || branchDragStore.get().active) {
			event.preventDefault();
			event.stopPropagation();
		}
	}

	function handlePendingBranchPointerMove(event: PointerEvent): void {
		const gesture = pendingBranchGesture;
		if (!gesture || event.pointerId !== gesture.pointerId) return;

		if ((event.buttons & 2) === 0) {
			clearPendingBranchGesture();
			return;
		}

		if (gesture.activated) return;

		const distance = Math.hypot(event.clientX - gesture.clientX, event.clientY - gesture.clientY);
		if (distance < BRANCH_DRAG_THRESHOLD) return;

		if (gesture.reuseJunctionNodeId && gesture.reuseJunctionFlowPosition && gesture.reuseJunctionScreenPosition) {
			branchDragStore.start({
				mode: 'junction',
				edgeId: null,
				junctionNodeId: gesture.reuseJunctionNodeId,
				domain: gesture.domain,
				domainColor: gesture.domainColor,
				junctionType: null,
				sourceNodeId: null,
				sourcePortIndex: null,
				targetNodeId: null,
				targetPortIndex: null,
				junctionFlowPosition: gesture.reuseJunctionFlowPosition,
				junctionScreenPosition: gesture.reuseJunctionScreenPosition,
				sourceJunctionPort: null,
				targetJunctionPort: null,
				segmentOrientation: null
			});
			branchDragStore.updatePointer({ x: event.clientX, y: event.clientY });
			pendingBranchGesture = { ...gesture, activated: true };
			return;
		}

		branchDragStore.start({
			mode: 'edge',
			edgeId: id,
			junctionNodeId: null,
			domain: gesture.domain,
			domainColor: gesture.domainColor,
			junctionType: gesture.junctionType,
			sourceNodeId: gesture.sourceNodeId,
			sourcePortIndex: gesture.sourcePortIndex,
			targetNodeId: gesture.targetNodeId,
			targetPortIndex: gesture.targetPortIndex,
			junctionFlowPosition: gesture.junctionFlowPosition,
			junctionScreenPosition: { x: gesture.clientX, y: gesture.clientY },
			sourceJunctionPort: gesture.sourceJunctionPort,
			targetJunctionPort: gesture.targetJunctionPort,
			segmentOrientation: gesture.segmentOrientation
		});
		branchDragStore.updatePointer({ x: event.clientX, y: event.clientY });
		pendingBranchGesture = { ...gesture, activated: true };
	}

	function handlePendingBranchPointerUp(event: PointerEvent): void {
		if (pendingBranchGesture && event.pointerId === pendingBranchGesture.pointerId) {
			clearPendingBranchGesture();
		}
	}

	function startBranchDrag(event: PointerEvent): void {
		if (event.button !== 2) return;

		if (sourcePortIndex === null || targetPortIndex === null || !domain) return;
		const junctionType = getAcausalJunctionType(domain);
		if (!junctionType) return;

		const junctionFlowPosition = screenToFlow({ x: event.clientX, y: event.clientY });
		const reusableJunction = getReusableJunctionCandidate(event.clientX, event.clientY);
		const { sourceJunctionPort, targetJunctionPort, segmentOrientation } = getJunctionPlacementForClick(
			junctionFlowPosition.x,
			junctionFlowPosition.y
		);

		event.stopPropagation();
		pendingBranchGesture = {
			clientX: event.clientX,
			clientY: event.clientY,
			domain,
			domainColor,
			junctionType,
			sourceNodeId: source,
			sourcePortIndex,
			targetNodeId: target,
			targetPortIndex,
			junctionFlowPosition,
			sourceJunctionPort,
			targetJunctionPort,
			segmentOrientation,
			reuseJunctionNodeId: reusableJunction?.junctionNodeId ?? null,
			reuseJunctionFlowPosition: reusableJunction?.junctionFlowPosition ?? null,
			reuseJunctionScreenPosition: reusableJunction?.junctionScreenPosition ?? null,
			pointerId: event.pointerId,
			activated: false
		};
		window.addEventListener('pointermove', handlePendingBranchPointerMove, true);
		window.addEventListener('pointerup', handlePendingBranchPointerUp, true);
		window.addEventListener('contextmenu', handlePendingBranchContextMenu, true);
	}

	onDestroy(() => {
		clearPendingBranchGesture();
	});
</script>

<!-- Acausal edge: orthogonal undirected line, domain-colored, with visible branch junctions -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<g data-branch-edge-id={id} class:selected class:highlighted={isHighlighted()} onpointerdown={startBranchDrag}>
	<BaseEdge
		{id}
		path={pathData()}
		style="stroke: {edgeColor()}; stroke-width: {selected ? 3.25 : isHighlighted() ? 2.25 : 1.75}; filter: {selected ? `drop-shadow(0 0 6px ${SELECTED_EDGE_COLOR})` : isHoverHighlighted() ? `drop-shadow(0 0 4px ${HOVER_EDGE_COLOR})` : 'none'}; {style ?? ''}"
	/>

	{#if showSourceJunction}
		<circle
			cx={sourceX}
			cy={sourceY}
			r={JUNCTION.dotSize / 2}
			class="junction-dot"
			style="fill: {edgeColor()}; --junction-dot-color: {edgeColor()};"
		/>
	{/if}

	{#if showTargetJunction}
		<circle
			cx={targetX}
			cy={targetY}
			r={JUNCTION.dotSize / 2}
			class="junction-dot"
			style="fill: {edgeColor()}; --junction-dot-color: {edgeColor()};"
		/>
	{/if}
</g>

<style>
	/* Widen clickable area via SvelteFlow's interaction path */
	:global(.svelte-flow__edge-interaction) {
		stroke-width: 20;
	}

	.junction-dot {
		stroke: var(--surface);
		stroke-width: 2;
		filter: drop-shadow(0 0 4px color-mix(in srgb, var(--junction-dot-color, var(--edge)) 45%, transparent));
		pointer-events: none;
	}
</style>
