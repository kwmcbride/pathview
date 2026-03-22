<script lang="ts">
	import { get } from 'svelte/store';
	import { onDestroy, untrack } from 'svelte';
	import {
		SvelteFlow,
		Background,
		BackgroundVariant,
		ConnectionMode,
		Position,
		getSmoothStepPath,
		type Node,
		type Edge,
		type Connection as FlowConnection,
		type NodeTypes,
		type EdgeTypes
	} from '@xyflow/svelte';
	import type { FinalConnectionState, OnConnectStartParams } from '@xyflow/system';
	import '@xyflow/svelte/dist/style.css';

	import { isInputFocused } from '$lib/utils/focus';
	import BaseNode from './nodes/BaseNode.svelte';
	import EventNode from './nodes/EventNode.svelte';
	import AnnotationNode from './nodes/AnnotationNode.svelte';
	import OrthogonalEdge from './edges/OrthogonalEdge.svelte';
	import AcausalEdge from './edges/AcausalEdge.svelte';
	import FlowUpdater from './FlowUpdater.svelte';
	import { graphStore } from '$lib/stores/graph';
	import { eventStore, setEventSelection } from '$lib/stores/events';
	import { selectedNodeIds as graphSelectedNodeIds } from '$lib/stores/graph/state';
	import { historyStore } from '$lib/stores/history';
	import { routingStore, buildRoutingContext, type PortInfo } from '$lib/stores/routing';
	import { hoveredHandle } from '$lib/stores/hoveredHandle';
	import { branchDragStore, type BranchDragState } from '$lib/stores/branchDrag';
	import { HANDLE_OFFSET, ARROW_INSET, type Direction, type PortStub } from '$lib/routing';
	import { themeStore, type Theme } from '$lib/stores/theme';
	import { clearSelectionTrigger, nudgeTrigger, selectNodeTrigger, registerHasSelection, triggerFitView } from '$lib/stores/viewActions';
	import { flowToScreen, screenToFlow } from '$lib/utils/viewUtils';
	import { dropTargetBridge } from '$lib/stores/dropTargetBridge';
	import { contextMenuStore } from '$lib/stores/contextMenu';
	import { nodeUpdatesStore } from '$lib/stores/nodeUpdates';
	import { nodeRegistry } from '$lib/nodes';
	import { getAcausalJunctionType, isAcausalJunctionNodeType, isAcausalNodeType } from '$lib/nodes/registry';
	import { HANDLE_ID } from '$lib/constants/handles';
	import { JUNCTION } from '$lib/constants/dimensions';
	import { NODE_TYPES } from '$lib/constants/nodeTypes';
	import { GRID_SIZE, SNAP_GRID, BACKGROUND_GAP } from '$lib/constants/grid';
	import { ACAUSAL_DOMAIN_COLORS } from '$lib/utils/colors';
	import type { NodeInstance, Connection, Annotation } from '$lib/nodes/types';
	import type { EventInstance } from '$lib/events/types';
	import type { BranchSegmentOrientation } from '$lib/stores/branchDrag';

	// Canvas utilities
	import {
		toFlowEdge,
		toEventNode,
		toAnnotationNode,
		rotateSelectedNodes,
		flipSelectedNodesHorizontal,
		flipSelectedNodesVertical,
		findFirstAvailableInputPort
	} from './canvas';

	// Theme for SvelteFlow
	let colorMode = $state<Theme>('dark');
	const unsubscribeTheme = themeStore.subscribe((theme) => {
		colorMode = theme;
	});

	let branchDrag: BranchDragState = $state(branchDragStore.get());
	const unsubscribeBranchDrag = branchDragStore.subscribe((state) => {
		branchDrag = state;
	});

	let currentHoveredHandle = $state<{ nodeId: string; handleId: string; color?: string } | null>(null);
	const unsubscribeHoveredHandle = hoveredHandle.subscribe((value) => {
		currentHoveredHandle = value;
	});

	interface PortConnectionBranchPreview {
		edgeId: string | null;
		domainColor: string;
		junctionType: string;
		dragSourceNodeId: string;
		dragSourcePortIndex: number;
		sourceNodeId: string | null;
		sourcePortIndex: number | null;
		targetNodeId: string | null;
		targetPortIndex: number | null;
		junctionFlowPosition: { x: number; y: number };
		junctionScreenPosition: { x: number; y: number };
		sourceJunctionPort: number | null;
		targetJunctionPort: number | null;
		branchPort: number;
		segmentOrientation: BranchSegmentOrientation;
		existingJunctionNodeId: string | null;
	}

	interface BranchWireDropPreview {
		edgeId: string | null;
		sourceNodeId: string | null;
		sourcePortIndex: number | null;
		targetNodeId: string | null;
		targetPortIndex: number | null;
		junctionFlowPosition: { x: number; y: number };
		junctionScreenPosition: { x: number; y: number };
		sourceJunctionPort: number | null;
		targetJunctionPort: number | null;
		branchPort: number;
		existingJunctionNodeId: string | null;
	}

	interface PortConnectionDragState {
		active: boolean;
		sourceNodeId: string | null;
		sourcePortIndex: number | null;
		sourceFlowPosition: { x: number; y: number } | null;
		sourceHandlePosition: Position | null;
		domain: string | null;
		domainColor: string;
		junctionType: string | null;
	}

	const PORT_CONNECTION_EDGE_HOVER_THRESHOLD = 14;
	const EXISTING_JUNCTION_REUSE_THRESHOLD = 10;
	let portConnectionBranchPreview = $state<PortConnectionBranchPreview | null>(null);
	let branchWireDropPreview = $state<BranchWireDropPreview | null>(null);
	let portConnectionDrag = $state<PortConnectionDragState>({
		active: false,
		sourceNodeId: null,
		sourcePortIndex: null,
		sourceFlowPosition: null,
		sourceHandlePosition: null,
		domain: null,
		domainColor: ACAUSAL_DOMAIN_COLORS.default,
		junctionType: null
	});

	
	// Track mouse position for waypoint placement
	let mousePosition = $state({ x: 0, y: 0 });

	function handleMouseMove(event: MouseEvent) {
		mousePosition = { x: event.clientX, y: event.clientY };
	}

	// Keyboard shortcuts for node manipulation
	function handleKeydown(event: KeyboardEvent) {
		if (isInputFocused(event)) return;

		// Handle Delete key (SvelteFlow's deleteKeyCode doesn't work reliably for 'Delete')
		if (event.key === 'Delete') {
			const selectedNodes = nodes.filter(n => n.selected);
			const selectedEdges = edges.filter(e => e.selected);
			if (selectedNodes.length > 0 || selectedEdges.length > 0) {
				event.preventDefault();
				handleDelete({ nodes: selectedNodes, edges: selectedEdges });
			}
			return;
		}

		// Handle backslash key - add waypoint to selected edge
		if (event.key === '\\') {
			const selectedEdge = edges.find(e => e.selected);
			if (selectedEdge) {
				event.preventDefault();
				// Convert screen position to flow coordinates
				const flowPos = screenToFlow(mousePosition);
				// Snap to grid
				const gridSize = 10;
				const snappedX = Math.round(flowPos.x / gridSize) * gridSize;
				const snappedY = Math.round(flowPos.y / gridSize) * gridSize;
				// Pass getPortInfo for immediate single-route recalculation (no full recalc needed)
				routingStore.addUserWaypoint(selectedEdge.id, { x: snappedX, y: snappedY }, getPortInfo);
			}
			return;
		}

		const hasSelection = nodes.some((n) => n.selected);
		if (!hasSelection) return;

		let updatedNodes: string[] = [];

		if (event.key === 'r' || event.key === 'R') {
			event.preventDefault();
			updatedNodes = rotateSelectedNodes(nodes);
		} else if (event.key === 'x' || event.key === 'X') {
			event.preventDefault();
			updatedNodes = flipSelectedNodesHorizontal(nodes);
		} else if (event.key === 'y' || event.key === 'Y') {
			event.preventDefault();
			updatedNodes = flipSelectedNodesVertical(nodes);
		}

		if (updatedNodes.length > 0) {
			pendingNodeUpdates = [...updatedNodes];
			// Recalculate routes for rotated/flipped nodes after FlowUpdater processes
			setTimeout(() => {
				const connections = get(graphStore.connections);
				routingStore.recalculateRoutesForNodes(new Set(updatedNodes), connections, getPortInfo);
			}, 0);
		}
	}

	// Track port counts to detect changes - used to force node re-renders
	let portCounts = new Map<string, { inputs: number; outputs: number }>();

	// Track nodes that need internal updates (will be processed by FlowUpdater)
	let pendingNodeUpdates: string[] = $state([]);

	// Subscribe to external node updates (e.g., from context menu rotation)
	const unsubscribeNodeUpdates = nodeUpdatesStore.subscribe((updates) => {
		if (updates.length > 0) {
			pendingNodeUpdates = [...pendingNodeUpdates, ...updates];
			nodeUpdatesStore.clear();
		}
	});

	// Register hasSelection function so +page.svelte can check SvelteFlow's selection state
	registerHasSelection(() => nodes.some(n => n.selected));

	// Subscribe to clear selection trigger - clears selection in SvelteFlow's nodes and edges
	let lastClearSelectionTrigger = 0;
	const unsubscribeClearSelection = clearSelectionTrigger.subscribe((trigger) => {
		if (trigger > lastClearSelectionTrigger) {
			lastClearSelectionTrigger = trigger;
			// Clear selection on all nodes and edges
			nodes = nodes.map(n => ({ ...n, selected: false }));
			edges = edges.map(e => ({ ...e, selected: false }));
			// Also clear store selection state using direct setters
			graphSelectedNodeIds.set(new Set());
			setEventSelection(new Set());
		}
	});

	// Subscribe to nudge trigger - nudges all selected nodes and syncs to stores
	let lastNudgeTrigger = 0;
	const unsubscribeNudge = nudgeTrigger.subscribe((trigger) => {
		if (trigger.id > lastNudgeTrigger) {
			lastNudgeTrigger = trigger.id;
			const delta = { x: trigger.x, y: trigger.y };

			// Update positions in SvelteFlow's nodes array
			nodes = nodes.map(n => {
				if (n.selected) {
					return { ...n, position: { x: n.position.x + delta.x, y: n.position.y + delta.y } };
				}
				return n;
			});

			// Sync positions to appropriate stores (as a single undoable action)
			historyStore.mutate(() => {
				nodes.forEach(n => {
					if (n.selected) {
						if (n.type === 'eventNode') {
							if (graphStore.isAtRoot()) {
								eventStore.updateEventPosition(n.id, n.position);
							} else {
								graphStore.updateSubsystemEventPosition(n.id, n.position);
							}
						} else if (n.type === 'annotation') {
							graphStore.updateAnnotationPosition(n.id, n.position);
						} else {
							graphStore.updateNodePosition(n.id, n.position);
						}
					}
				});
			});
		}
	});

	// Subscribe to select node trigger - selects specific nodes in SvelteFlow
	let lastSelectNodeTrigger = 0;
	const unsubscribeSelectNode = selectNodeTrigger.subscribe((trigger) => {
		if (trigger.id > lastSelectNodeTrigger) {
			lastSelectNodeTrigger = trigger.id;
			const nodeIdsToSelect = new Set(trigger.nodeIds);

			// Update selection in SvelteFlow's nodes array
			nodes = nodes.map(n => {
				if (nodeIdsToSelect.has(n.id)) {
					return { ...n, selected: true };
				} else if (!trigger.addToSelection) {
					return { ...n, selected: false };
				}
				return n;
			});

			// Clear edge selection when selecting nodes
			if (!trigger.addToSelection) {
				edges = edges.map(e => ({ ...e, selected: false }));
			}

			// Sync to stores - note: we update stores directly here to avoid triggering again
			syncSelectionToStores();
		}
	});

	// Helper to sync SvelteFlow selection state to stores
	// Uses direct setters to avoid triggering the selection trigger (which would loop)
	function syncSelectionToStores() {
		const selectedNodes = nodes.filter(n => n.selected);

		// Build sets of selected IDs by type
		const selectedBlockIds = new Set<string>();
		const selectedEventIdSet = new Set<string>();

		selectedNodes.forEach((node) => {
			if (node.type === 'eventNode') {
				selectedEventIdSet.add(node.id);
			} else if (node.type !== 'annotation') {
				selectedBlockIds.add(node.id);
			}
		});

		// Update stores directly (bypasses trigger-based functions)
		graphSelectedNodeIds.set(selectedBlockIds);
		setEventSelection(selectedEventIdSet);
	}

	// Cleanup function - will add subscriptions as they're defined
	const cleanups: (() => void)[] = [
		unsubscribeTheme,
		unsubscribeBranchDrag,
		unsubscribeHoveredHandle,
		unsubscribeNodeUpdates,
		unsubscribeClearSelection,
		unsubscribeNudge,
		unsubscribeSelectNode,
		() => {
			if (pendingJunctionAutoOptimize) {
				clearTimeout(pendingJunctionAutoOptimize);
			}
		}
	];
	onDestroy(() => cleanups.forEach(fn => fn()));

	function clearPendingUpdates() {
		pendingNodeUpdates = [];
	}

	function getBranchPreviewSourcePosition(): Position {
		const origin = branchDrag.junctionScreenPosition;
		const current = branchDrag.currentScreenPosition ?? origin;
		if (!origin || !current || branchDrag.segmentOrientation === null) {
			const dx = (current?.x ?? 0) - (origin?.x ?? 0);
			const dy = (current?.y ?? 0) - (origin?.y ?? 0);
			if (Math.abs(dx) >= Math.abs(dy)) {
				return dx >= 0 ? Position.Right : Position.Left;
			}
			return dy >= 0 ? Position.Bottom : Position.Top;
		}

		if (branchDrag.segmentOrientation === 'vertical') {
			return current.x >= origin.x ? Position.Right : Position.Left;
		}

		return current.y >= origin.y ? Position.Bottom : Position.Top;
	}

	function getBranchJunctionPort(position: Position): number {
		switch (position) {
			case Position.Left:
				return 0;
			case Position.Right:
				return 1;
			case Position.Top:
				return 2;
			case Position.Bottom:
				return 3;
			default:
				return 1;
		}
	}

	function getOccupiedJunctionPorts(nodeId: string): Set<number> {
		const currentConnections = get(graphStore.connections);
		const occupied = new Set<number>();
		for (const connection of currentConnections) {
			if (connection.kind !== 'acausal') continue;
			if (connection.sourceNodeId === nodeId) occupied.add(connection.sourcePortIndex);
			if (connection.targetNodeId === nodeId) occupied.add(connection.targetPortIndex);
		}
		return occupied;
	}

	function getAvailableJunctionBranchPort(nodeId: string, preferredPosition: Position): number | null {
		const occupied = getOccupiedJunctionPorts(nodeId);
		return getAvailablePreviewJunctionPort(preferredPosition, occupied);
	}

	function getAvailablePreviewJunctionPort(preferredPosition: Position, occupied: Set<number>): number | null {
		const preferredPort = getBranchJunctionPort(preferredPosition);
		if (!occupied.has(preferredPort)) return preferredPort;

		const fallbacks =
			preferredPosition === Position.Left || preferredPosition === Position.Right
				? [Position.Top, Position.Bottom, Position.Left, Position.Right]
				: [Position.Left, Position.Right, Position.Top, Position.Bottom];

		for (const position of fallbacks) {
			const port = getBranchJunctionPort(position);
			if (!occupied.has(port)) return port;
		}

		return null;
	}

	function getPreferredPositionFromDelta(dx: number, dy: number): Position {
		if (Math.abs(dx) >= Math.abs(dy)) {
			return dx >= 0 ? Position.Right : Position.Left;
		}
		return dy >= 0 ? Position.Bottom : Position.Top;
	}

	function getReusableJunctionPreview(
		connection: Connection,
		dragSourceFlowPosition: { x: number; y: number },
		pointerFlowPosition: { x: number; y: number }
	): {
		junctionNodeId: string;
		junctionFlowPosition: { x: number; y: number };
		junctionScreenPosition: { x: number; y: number };
		branchPort: number;
	} | null {
		const candidates: Array<{
			junctionNodeId: string;
			junctionFlowPosition: { x: number; y: number };
			junctionScreenPosition: { x: number; y: number };
			branchPort: number;
			distance: number;
		}> = [];

		for (const nodeId of [connection.sourceNodeId, connection.targetNodeId]) {
			const node = graphStore.getNode(nodeId);
			if (!node || !isAcausalJunctionNodeType(node.type)) continue;

			const branchPort = getAvailableJunctionBranchPort(
				nodeId,
				getPreferredPositionFromDelta(
					dragSourceFlowPosition.x - node.position.x,
					dragSourceFlowPosition.y - node.position.y
				)
			);
			if (branchPort === null) continue;

			const junctionFlowPosition = { x: node.position.x, y: node.position.y };
			const junctionScreenPosition = flowToScreen(junctionFlowPosition);
			const screenDistance = Math.hypot(
				mousePosition.x - junctionScreenPosition.x,
				mousePosition.y - junctionScreenPosition.y
			);
			if (screenDistance > EXISTING_JUNCTION_REUSE_THRESHOLD) continue;

			candidates.push({
				junctionNodeId: nodeId,
				junctionFlowPosition,
				junctionScreenPosition,
				branchPort,
				distance: Math.hypot(
					pointerFlowPosition.x - junctionFlowPosition.x,
					pointerFlowPosition.y - junctionFlowPosition.y
				)
			});
		}

		if (candidates.length === 0) return null;
		candidates.sort((a, b) => a.distance - b.distance);
		const best = candidates[0];
		return {
			junctionNodeId: best.junctionNodeId,
			junctionFlowPosition: best.junctionFlowPosition,
			junctionScreenPosition: best.junctionScreenPosition,
			branchPort: best.branchPort
		};
	}

	function resolveBranchWireDropPreview(): BranchWireDropPreview | null {
		if (!branchDrag.active || !branchDrag.domain || !branchDrag.junctionFlowPosition) {
			return null;
		}

		const pointerFlowPosition = screenToFlow(mousePosition);
		const sourceFlowPosition = branchDrag.junctionFlowPosition;
		const currentConnections = get(graphStore.connections);
		let bestPreview: BranchWireDropPreview | null = null;
		let bestDistance = Number.POSITIVE_INFINITY;

		const edgeElements = document.querySelectorAll<SVGGElement>('[data-branch-edge-id]');
		for (const edgeEl of edgeElements) {
			const edgeId = edgeEl.dataset.branchEdgeId;
			if (!edgeId) continue;
			if (branchDrag.mode === 'edge' && edgeId === branchDrag.edgeId) continue;

			const existingConnection = currentConnections.find(
				(connection) => connection.id === edgeId && connection.kind === 'acausal'
			);
			if (!existingConnection || existingConnection.domain !== branchDrag.domain) continue;

			const pathEl = edgeEl.querySelector('path') as SVGPathElement | null;
			if (!pathEl) continue;

			const placement = getPathJunctionPlacement(pathEl, pointerFlowPosition.x, pointerFlowPosition.y, Position.Right);
			if (!placement) continue;

			const closestPointScreenPosition = flowToScreen({
				x: placement.closestPoint.x,
				y: placement.closestPoint.y
			});
			const distance = Math.hypot(
				closestPointScreenPosition.x - mousePosition.x,
				closestPointScreenPosition.y - mousePosition.y
			);
			if (distance > PORT_CONNECTION_EDGE_HOVER_THRESHOLD || distance >= bestDistance) continue;

			const reusableJunction = getReusableJunctionPreview(
				existingConnection,
				sourceFlowPosition,
				pointerFlowPosition
			);
			if (reusableJunction) {
				if (branchDrag.mode === 'junction' && reusableJunction.junctionNodeId === branchDrag.junctionNodeId) {
					continue;
				}
				bestDistance = distance;
				bestPreview = {
					edgeId: null,
					sourceNodeId: null,
					sourcePortIndex: null,
					targetNodeId: null,
					targetPortIndex: null,
					junctionFlowPosition: reusableJunction.junctionFlowPosition,
					junctionScreenPosition: reusableJunction.junctionScreenPosition,
					sourceJunctionPort: null,
					targetJunctionPort: null,
					branchPort: reusableJunction.branchPort,
					existingJunctionNodeId: reusableJunction.junctionNodeId
				};
				continue;
			}

			const branchPort = getAvailablePreviewJunctionPort(
				getPreferredPositionFromDelta(
					sourceFlowPosition.x - placement.closestPoint.x,
					sourceFlowPosition.y - placement.closestPoint.y
				),
				new Set([placement.sourceJunctionPort, placement.targetJunctionPort])
			);
			if (branchPort === null) continue;

			bestDistance = distance;
			bestPreview = {
				edgeId,
				sourceNodeId: existingConnection.sourceNodeId,
				sourcePortIndex: existingConnection.sourcePortIndex,
				targetNodeId: existingConnection.targetNodeId,
				targetPortIndex: existingConnection.targetPortIndex,
				junctionFlowPosition: { x: placement.closestPoint.x, y: placement.closestPoint.y },
				junctionScreenPosition: closestPointScreenPosition,
				sourceJunctionPort: placement.sourceJunctionPort,
				targetJunctionPort: placement.targetJunctionPort,
				branchPort,
				existingJunctionNodeId: null
			};
		}

		return bestPreview;
	}

	function getClosestPointOnPath(
		pathEl: SVGPathElement,
		x: number,
		y: number
	): { x: number; y: number; length: number; totalLength: number } | null {
		const totalLength = pathEl.getTotalLength();
		if (totalLength <= 0) return null;

		const sampleStep = Math.max(2, Math.min(6, totalLength / 48));
		let closestLength = 0;
		let closestDistance = Number.POSITIVE_INFINITY;

		for (let length = 0; length <= totalLength; length += sampleStep) {
			const point = pathEl.getPointAtLength(length);
			const distance = Math.hypot(point.x - x, point.y - y);
			if (distance < closestDistance) {
				closestDistance = distance;
				closestLength = length;
			}
		}

		if (closestLength !== totalLength) {
			const endPoint = pathEl.getPointAtLength(totalLength);
			const endDistance = Math.hypot(endPoint.x - x, endPoint.y - y);
			if (endDistance < closestDistance) {
				closestLength = totalLength;
			}
		}

		const point = pathEl.getPointAtLength(closestLength);
		return { x: point.x, y: point.y, length: closestLength, totalLength };
	}

	function getPathJunctionPlacement(
		pathEl: SVGPathElement,
		clickX: number,
		clickY: number,
		fallbackSourcePosition: Position
	): {
		sourceJunctionPort: number;
		targetJunctionPort: number;
		segmentOrientation: BranchSegmentOrientation;
		closestPoint: { x: number; y: number };
	} | null {
		const closestPoint = getClosestPointOnPath(pathEl, clickX, clickY);
		if (!closestPoint) return null;

		const fallback =
			fallbackSourcePosition === Position.Top || fallbackSourcePosition === Position.Bottom
				? (
					fallbackSourcePosition === Position.Bottom
						? { sourceJunctionPort: 2, targetJunctionPort: 3, segmentOrientation: 'vertical' as const }
						: { sourceJunctionPort: 3, targetJunctionPort: 2, segmentOrientation: 'vertical' as const }
				)
				: (
					fallbackSourcePosition === Position.Right
						? { sourceJunctionPort: 0, targetJunctionPort: 1, segmentOrientation: 'horizontal' as const }
						: { sourceJunctionPort: 1, targetJunctionPort: 0, segmentOrientation: 'horizontal' as const }
				);

		const tangentOffset = Math.max(2, Math.min(8, closestPoint.totalLength / 24));
		const before = pathEl.getPointAtLength(Math.max(0, closestPoint.length - tangentOffset));
		const after = pathEl.getPointAtLength(Math.min(closestPoint.totalLength, closestPoint.length + tangentOffset));
		const dx = after.x - before.x;
		const dy = after.y - before.y;

		if (Math.abs(dx) < 1e-6 && Math.abs(dy) < 1e-6) {
			return { ...fallback, closestPoint: { x: closestPoint.x, y: closestPoint.y } };
		}

		if (Math.abs(dx) >= Math.abs(dy)) {
			return {
				sourceJunctionPort: dx >= 0 ? 0 : 1,
				targetJunctionPort: dx >= 0 ? 1 : 0,
				segmentOrientation: 'horizontal',
				closestPoint: { x: closestPoint.x, y: closestPoint.y }
			};
		}

		return {
			sourceJunctionPort: dy >= 0 ? 2 : 3,
			targetJunctionPort: dy >= 0 ? 3 : 2,
			segmentOrientation: 'vertical',
			closestPoint: { x: closestPoint.x, y: closestPoint.y }
		};
	}

	function resolvePortConnectionBranchPreview(): PortConnectionBranchPreview | null {
		if (
			!portConnectionDrag.active ||
			!portConnectionDrag.sourceNodeId ||
			portConnectionDrag.sourcePortIndex === null ||
			!portConnectionDrag.sourceFlowPosition ||
			!portConnectionDrag.sourceHandlePosition ||
			!portConnectionDrag.domain ||
			!portConnectionDrag.junctionType
		) {
			return null;
		}
		const dragSourceNodeId = portConnectionDrag.sourceNodeId;
		const dragSourcePortIndex = portConnectionDrag.sourcePortIndex;
		const pointerFlowPosition = screenToFlow(mousePosition);
		const { domain, junctionType } = portConnectionDrag;

		const graphNodes = get(graphStore.nodesArray);
		const dragSourceNode = graphNodes.find((node) => node.id === dragSourceNodeId);
		if (!dragSourceNode || isAcausalJunctionNodeType(dragSourceNode.type)) {
			return null;
		}

		const currentConnections = get(graphStore.connections);
		let bestPreview: PortConnectionBranchPreview | null = null;
		let bestDistance = Number.POSITIVE_INFINITY;

		const edgeElements = document.querySelectorAll<SVGGElement>('[data-branch-edge-id]');
		for (const edgeEl of edgeElements) {
			const edgeId = edgeEl.dataset.branchEdgeId;
			if (!edgeId) continue;

			const existingConnection = currentConnections.find(
				(connection) => connection.id === edgeId && connection.kind === 'acausal'
			);
			if (!existingConnection || existingConnection.domain !== domain) continue;

			if (
				(existingConnection.sourceNodeId === dragSourceNodeId &&
					existingConnection.sourcePortIndex === dragSourcePortIndex) ||
				(existingConnection.targetNodeId === dragSourceNodeId &&
					existingConnection.targetPortIndex === dragSourcePortIndex)
			) {
				continue;
			}

			const pathEl = edgeEl.querySelector('path') as SVGPathElement | null;
			if (!pathEl) continue;

			const placement = getPathJunctionPlacement(
				pathEl,
				pointerFlowPosition.x,
				pointerFlowPosition.y,
				portConnectionDrag.sourceHandlePosition
			);
			if (!placement) continue;

			const closestPointScreenPosition = flowToScreen({
				x: placement.closestPoint.x,
				y: placement.closestPoint.y
			});
			const distance = Math.hypot(
				closestPointScreenPosition.x - mousePosition.x,
				closestPointScreenPosition.y - mousePosition.y
			);
			if (distance > PORT_CONNECTION_EDGE_HOVER_THRESHOLD || distance >= bestDistance) continue;

			const reusableJunction = getReusableJunctionPreview(
				existingConnection,
				portConnectionDrag.sourceFlowPosition,
				pointerFlowPosition
			);
			if (reusableJunction) {
				bestDistance = distance;
				bestPreview = {
					edgeId: null,
					domainColor: portConnectionDrag.domainColor,
					junctionType,
					dragSourceNodeId,
					dragSourcePortIndex,
					sourceNodeId: null,
					sourcePortIndex: null,
					targetNodeId: null,
					targetPortIndex: null,
					junctionFlowPosition: reusableJunction.junctionFlowPosition,
					junctionScreenPosition: reusableJunction.junctionScreenPosition,
					sourceJunctionPort: null,
					targetJunctionPort: null,
					branchPort: reusableJunction.branchPort,
					segmentOrientation: placement.segmentOrientation,
					existingJunctionNodeId: reusableJunction.junctionNodeId
				};
				continue;
			}

			const junctionScreenPosition = flowToScreen({
				x: placement.closestPoint.x,
				y: placement.closestPoint.y
			});

			const branchPort = getAvailablePreviewJunctionPort(
				getPreferredPositionFromDelta(
					portConnectionDrag.sourceFlowPosition.x - placement.closestPoint.x,
					portConnectionDrag.sourceFlowPosition.y - placement.closestPoint.y
				),
				new Set([placement.sourceJunctionPort, placement.targetJunctionPort])
			);
			if (branchPort === null) continue;

			bestDistance = distance;
			bestPreview = {
				edgeId,
				domainColor: portConnectionDrag.domainColor,
				junctionType,
				dragSourceNodeId,
				dragSourcePortIndex,
				sourceNodeId: existingConnection.sourceNodeId,
				sourcePortIndex: existingConnection.sourcePortIndex,
				targetNodeId: existingConnection.targetNodeId,
				targetPortIndex: existingConnection.targetPortIndex,
				junctionFlowPosition: { x: placement.closestPoint.x, y: placement.closestPoint.y },
				junctionScreenPosition,
				sourceJunctionPort: placement.sourceJunctionPort,
				targetJunctionPort: placement.targetJunctionPort,
				branchPort,
				segmentOrientation: placement.segmentOrientation,
				existingJunctionNodeId: null
			};
		}

		return bestPreview;
	}

	function getPreferredJunctionDropPosition(nodeEl: HTMLElement, clientX: number, clientY: number): Position {
		const rect = nodeEl.getBoundingClientRect();
		const centerX = rect.left + rect.width / 2;
		const centerY = rect.top + rect.height / 2;
		const dx = clientX - centerX;
		const dy = clientY - centerY;

		if (Math.abs(dx) >= Math.abs(dy)) {
			return dx >= 0 ? Position.Right : Position.Left;
		}

		return dy >= 0 ? Position.Bottom : Position.Top;
	}

	function getPreviewTargetPosition(sourcePosition: Position): Position {
		const origin = branchDrag.junctionScreenPosition;
		const current = branchDrag.currentScreenPosition ?? origin;
		if (!origin || !current) return Position.Left;

		const dx = current.x - origin.x;
		const dy = current.y - origin.y;

		if (Math.abs(dx) >= Math.abs(dy)) {
			return dx >= 0 ? Position.Left : Position.Right;
		}

		return dy >= 0 ? Position.Top : Position.Bottom;
	}

	function getBranchPreviewPath(): string | null {
		const origin = branchDrag.junctionScreenPosition;
		const current = branchDrag.currentScreenPosition ?? origin;
		if (!branchDrag.active || !origin || !current) return null;

		const sourcePosition = getBranchPreviewSourcePosition();
		const targetPosition = getPreviewTargetPosition(sourcePosition);
		const [path] = getSmoothStepPath({
			sourceX: origin.x,
			sourceY: origin.y,
			sourcePosition,
			targetX: current.x,
			targetY: current.y,
			targetPosition,
			borderRadius: 8
		});
		return path;
	}

	// Helper to get port position and direction in world coordinates
	// Returns handle tip position (accounting for handle offset from block edge)
	// For inputs, also accounts for arrowhead so stub starts within arrow
	function getPortInfo(nodeId: string, portIndex: number, isOutput: boolean): PortInfo | null {
		const node = nodes.find(n => n.id === nodeId);
		if (!node) return null;

		const nodeData = node.data as NodeInstance;
		const ports = isOutput ? nodeData.outputs : nodeData.inputs;
		if (portIndex >= ports.length) return null;

		const rotation = (nodeData.params?.['_rotation'] as number) || 0;
		const width = node.measured?.width ?? node.width ?? 80;
		const height = node.measured?.height ?? node.height ?? 40;

		// Calculate port offset from center based on rotation
		const portCount = ports.length;
		const portSpacing = 20; // G.x2
		const span = (portCount - 1) * portSpacing;
		const offsetFromCenter = -span / 2 + portIndex * portSpacing;

		let x = node.position.x;
		let y = node.position.y;
		let direction: Direction;

		// Additional offset: handle tip is HANDLE_OFFSET outside block edge
		// For inputs (targets), add ARROW_INSET so stub starts within arrowhead
		const extraOffset = isOutput ? HANDLE_OFFSET : (HANDLE_OFFSET + ARROW_INSET);

		// Position and direction based on rotation (output = right side for rotation 0)
		if (isOutput) {
			switch (rotation) {
				case 1: // outputs at bottom
					x += offsetFromCenter;
					y += height / 2 + extraOffset;
					direction = 'down';
					break;
				case 2: // outputs at left
					x -= width / 2 + extraOffset;
					y += offsetFromCenter;
					direction = 'left';
					break;
				case 3: // outputs at top
					x += offsetFromCenter;
					y -= height / 2 + extraOffset;
					direction = 'up';
					break;
				default: // rotation 0 - outputs at right
					x += width / 2 + extraOffset;
					y += offsetFromCenter;
					direction = 'right';
					break;
			}
		} else {
			// Inputs are opposite to outputs
			switch (rotation) {
				case 1: // inputs at top
					x += offsetFromCenter;
					y -= height / 2 + extraOffset;
					direction = 'up';
					break;
				case 2: // inputs at right
					x += width / 2 + extraOffset;
					y += offsetFromCenter;
					direction = 'right';
					break;
				case 3: // inputs at bottom
					x += offsetFromCenter;
					y += height / 2 + extraOffset;
					direction = 'down';
					break;
				default: // rotation 0 - inputs at left
					x -= width / 2 + extraOffset;
					y += offsetFromCenter;
					direction = 'left';
					break;
			}
		}

		return { position: { x, y }, direction };
	}

	// Update routing context and recalculate all routes
	function updateRoutingContext() {
		// Only include block nodes (not events or annotations) for routing
		const blockNodesForRouting = nodes.filter(
			(n) =>
				n.type === 'pathview' &&
				!isAcausalJunctionNodeType((n.data as NodeInstance).type)
		);
		if (blockNodesForRouting.length === 0) {
			routingStore.clearRoutes();
			return;
		}

		const { nodeBounds, canvasBounds } = buildRoutingContext(blockNodesForRouting);

		// Collect all port stubs for obstacle marking
		const portStubs: PortStub[] = [];
		for (const node of blockNodesForRouting) {
			const nodeData = node.data as NodeInstance;
			// Collect input port stubs
			for (let i = 0; i < nodeData.inputs.length; i++) {
				const info = getPortInfo(node.id, i, false);
				if (info) portStubs.push({ position: info.position, direction: info.direction });
			}
			// Collect output port stubs
			for (let i = 0; i < nodeData.outputs.length; i++) {
				const info = getPortInfo(node.id, i, true);
				if (info) portStubs.push({ position: info.position, direction: info.direction });
			}
		}

		routingStore.setContext(nodeBounds, canvasBounds, portStubs);

		// Recalculate all routes
		const connections = get(graphStore.connections);
		routingStore.recalculateAllRoutes(connections, getPortInfo);
	}

	// Custom node types - will add more for different shapes
	const nodeTypes: NodeTypes = {
		pathview: BaseNode,
		eventNode: EventNode,
		annotation: AnnotationNode
	};

	// Custom edge types - orthogonal routing with arrow (causal) or bezier line (acausal)
	const edgeTypes: EdgeTypes = {
		orthogonal: OrthogonalEdge,
		acausal: AcausalEdge
	};

	// SvelteFlow state - this is the source of truth for visual state
	// Block nodes from graphStore
	let blockNodes = $state<Node[]>([]);
	// Event nodes from eventStore
	let eventNodes = $state<Node[]>([]);
	// Annotation nodes from graphStore
	let annotationNodes = $state<Node[]>([]);
	// Combined nodes for SvelteFlow
	let nodes = $state<Node[]>([]);
	let edges = $state<Edge[]>([]);

	// Merge block, event, and annotation nodes when any changes
	// Preserve position and selection from SvelteFlow's current state (except during undo/redo)
	$effect(() => {
		const currentNodes = untrack(() => new Map(nodes.map(n => [n.id, n])));
		const restoring = historyStore.isRestoringState();

		nodes = [...blockNodes, ...eventNodes, ...annotationNodes].map(n => {
			const existing = currentNodes.get(n.id);
			if (existing && !restoring) {
				// Preserve SvelteFlow-managed state (position during drag, selection)
				return { ...n, position: existing.position, selected: existing.selected };
			}
			return n;
		});
	});

	// Track if we're currently syncing to prevent loops
	let isSyncing = false;
	let isAutoOptimizingJunctions = false;
	let pendingJunctionAutoOptimize: ReturnType<typeof setTimeout> | null = null;

	// Track if initial load is complete (positions from graph store should be used until first render)
	let initialLoadComplete = false;

	// Track previous node IDs to detect deletions via binding
	let prevNodeIds = new Set<string>();

	// Watch for node deletions (SvelteFlow updates nodes via binding, not always via callback)
	// Only delete nodes that are truly gone - not just filtered out by subsystem navigation
	$effect(() => {
		const currentNodeIds = new Set(nodes.map(n => n.id));

		// Find nodes that disappeared from view
		const disappearedIds = [...prevNodeIds].filter(id => !currentNodeIds.has(id));

		if (disappearedIds.length > 0 && !isSyncing) {
			isSyncing = true;
			// Only remove if the node is truly deleted (not in full store)
			// Nodes that are just filtered out by navigation should NOT be removed
			disappearedIds.forEach(id => {
				const stillInGraphStore = graphStore.getNode(id);
				const stillInEventStore = eventStore.getEvent(id);
				if (!stillInGraphStore && !stillInEventStore) {
					// Node was actually deleted by SvelteFlow, clean up
					portCounts.delete(id);
				}
			});
			isSyncing = false;
		}

		// Update previous node IDs
		prevNodeIds = currentNodeIds;
	});

	// Sync annotation dimensions when NodeResizer updates them
	$effect(() => {
		if (isSyncing) return;
		nodes.forEach(node => {
			if (node.type === 'annotation' && node.width && node.height) {
				const annotation = graphStore.getAnnotation(node.id);
				if (annotation && (annotation.width !== node.width || annotation.height !== node.height)) {
					isSyncing = true;
					graphStore.updateAnnotation(node.id, {
						width: node.width,
						height: node.height
					});
					isSyncing = false;
				}
			}
		});
	});

	// Subscribe to current nodes (filtered by current navigation context)
	cleanups.push(graphStore.nodes.subscribe((graphNodesMap: Map<string, NodeInstance>) => {
		if (isSyncing) return;

		// Convert Map to array for processing
		const filteredGraphNodes = Array.from(graphNodesMap.values());

		// Track nodes that need handle updates (port count changed)
		const nodesToUpdate: string[] = [];

		// Create a map of current nodes for quick lookup
		const currentNodesMap = new Map(nodes.map(n => [n.id, n]));

		// Find nodes to add, update, or remove
		const newNodeIds = new Set(filteredGraphNodes.map(n => n.id));
		const currentNodeIds = new Set(nodes.map(n => n.id));

		// Check if there are actual changes
		const hasAdditions = filteredGraphNodes.some(gn => !currentNodeIds.has(gn.id));
		const hasRemovals = nodes.some(n => !newNodeIds.has(n.id));
		const hasDataChanges = filteredGraphNodes.some(gn => {
			const current = currentNodesMap.get(gn.id);
			if (!current) return false;
			const currentData = current.data as NodeInstance;
			// Check if data actually changed (params, ports, name, color, pinnedParams)
			const prevCounts = portCounts.get(gn.id);
			const newCounts = { inputs: gn.inputs.length, outputs: gn.outputs.length };
			if (prevCounts && (prevCounts.inputs !== newCounts.inputs || prevCounts.outputs !== newCounts.outputs)) {
				return true;
			}
			if (currentData.name !== gn.name) return true;
			if (currentData.color !== gn.color) return true;
			if (JSON.stringify(currentData.params) !== JSON.stringify(gn.params)) return true;
			if (JSON.stringify(currentData.pinnedParams) !== JSON.stringify(gn.pinnedParams)) return true;
			return false;
		});

		// Only rebuild if there are actual changes
		if (!hasAdditions && !hasRemovals && !hasDataChanges && initialLoadComplete) {
			return;
		}

		// Build updated nodes array, preserving existing node objects where possible
		const updatedNodes = filteredGraphNodes.map((graphNode) => {
			const existingNode = currentNodesMap.get(graphNode.id);

			// Check if port counts changed
			const prevCounts = portCounts.get(graphNode.id);
			const newCounts = { inputs: graphNode.inputs.length, outputs: graphNode.outputs.length };

			if (prevCounts && (prevCounts.inputs !== newCounts.inputs || prevCounts.outputs !== newCounts.outputs)) {
				nodesToUpdate.push(graphNode.id);
			}
			portCounts.set(graphNode.id, newCounts);

			// Check if rotation changed - need to update internals for handle positions
			if (existingNode) {
				const existingData = existingNode.data as NodeInstance;
				const oldRotation = existingData?.params?.['_rotation'] ?? 0;
				const newRotation = graphNode.params?.['_rotation'] ?? 0;
				if (oldRotation !== newRotation) {
					nodesToUpdate.push(graphNode.id);
				}
			}

			// Use store position when restoring (undo/redo), otherwise preserve existing position
			const position = (existingNode && !historyStore.isRestoringState())
				? existingNode.position
				: { ...graphNode.position };

			// Interface blocks are not deletable
			const isInterface = graphNode.type === NODE_TYPES.INTERFACE;

			// Don't set explicit width/height - let SvelteFlow auto-measure from DOM
			// BaseNode controls its size via CSS, SvelteFlow reads it via updateNodeInternals

			// If node exists, update data but don't preserve selection here
			// Selection is managed by SvelteFlow, trigger subscriptions, and merge effect
			if (existingNode) {
				return {
					id: existingNode.id,
					type: existingNode.type,
					position,
					data: graphNode,
					// Explicit center origin for correct bounds calculation
					origin: [0.5, 0.5] as [number, number],
					selectable: existingNode.selectable,
					draggable: existingNode.draggable,
					deletable: !isInterface
					// NOTE: selected is intentionally NOT preserved here to avoid stale selection
				} as Node<NodeInstance>;
			}

			// New node
			return {
				id: graphNode.id,
				type: 'pathview',
				position,
				data: graphNode,
				// Explicit center origin for correct bounds calculation
				origin: [0.5, 0.5] as [number, number],
				selectable: true,
				draggable: true,
				deletable: !isInterface
			} as Node<NodeInstance>;
		});

		// Clean up port counts for removed nodes
		for (const id of portCounts.keys()) {
			if (!newNodeIds.has(id)) {
				portCounts.delete(id);
			}
		}

		blockNodes = updatedNodes;

		// Queue node internal updates for nodes with changed ports/rotation
		if (nodesToUpdate.length > 0) {
			pendingNodeUpdates = [...nodesToUpdate];
			// Recalculate routes for affected nodes after FlowUpdater processes
			setTimeout(() => {
				const connections = get(graphStore.connections);
				routingStore.recalculateRoutesForNodes(new Set(nodesToUpdate), connections, getPortInfo);
			}, 0);
		}

		// Mark initial load as complete after first non-empty sync
		if (filteredGraphNodes.length > 0 && !initialLoadComplete) {
			setTimeout(() => {
				initialLoadComplete = true;
			}, 100);
		}
	}));

	// Track current path and events
	let currentPath: string[] = [];
	let rootEvents: EventInstance[] = [];
	let subsystemEvents: EventInstance[] = [];

	// Update event nodes - show root events at root, subsystem events inside subsystems
	// Note: No isSyncing check here - this only updates eventNodes array,
	// doesn't write to stores, so no risk of infinite loops
	function updateEventNodes() {
		const events = currentPath.length === 0 ? rootEvents : subsystemEvents;
		eventNodes = events.map(toEventNode);
	}

	// Subscribe to path changes
	cleanups.push(graphStore.currentPath.subscribe((path) => {
		currentPath = path;
		updateEventNodes();
		// Clear grid and routes when navigating - forces full rebuild for new context
		routingStore.clearContext();
	}));

	// Subscribe to root-level events (eventStore)
	cleanups.push(eventStore.eventsArray.subscribe((events: EventInstance[]) => {
		rootEvents = events;
		updateEventNodes();
	}));

	// Subscribe to subsystem events (graphStore)
	cleanups.push(graphStore.subsystemEvents.subscribe((eventsMap: Map<string, EventInstance>) => {
		subsystemEvents = Array.from(eventsMap.values());
		updateEventNodes();
	}));

	// Subscribe to annotations (filtered by current navigation context)
	cleanups.push(graphStore.annotations.subscribe((annotationsMap: Map<string, Annotation>) => {
		annotationNodes = Array.from(annotationsMap.values()).map(toAnnotationNode);
	}));

	// Subscribe to current connections (filtered by current navigation context)
	cleanups.push(graphStore.connections.subscribe((connections: Connection[]) => {
		if (isSyncing) return;
		// Preserve selection state from existing edges
		const currentEdgeSelection = new Map(edges.map(e => [e.id, e.selected]));
		edges = connections.map(conn => {
			const edge = toFlowEdge(conn);
			// Preserve selection state
			const wasSelected = currentEdgeSelection.get(conn.id);
			if (wasSelected) {
				edge.selected = true;
			}
			return edge;
		});
		// Recalculate routes when connections change
		// Use setTimeout to ensure nodes are updated first
		setTimeout(() => updateRoutingContext(), 0);

		if (isAutoOptimizingJunctions) return;
		if (pendingJunctionAutoOptimize) {
			clearTimeout(pendingJunctionAutoOptimize);
		}
		pendingJunctionAutoOptimize = setTimeout(() => {
			pendingJunctionAutoOptimize = null;
			const hasJunctions = get(graphStore.nodesArray).some((node) => isAcausalJunctionNodeType(node.type));
			const hasAcausalConnections = get(graphStore.connections).some((connection) => connection.kind === 'acausal');
			if (!hasJunctions || !hasAcausalConnections) return;

			isAutoOptimizingJunctions = true;
			try {
				graphStore.optimizeAllJunctionPorts();
			} finally {
				isAutoOptimizingJunctions = false;
			}
		}, 0);
	}));

	// Track last snapped positions during drag for discrete routing updates
	let lastDraggedPositions = new Map<string, { x: number; y: number }>();

	// Handle node drag start - capture state for undo
	function handleNodeDragStart({ nodes: draggedNodes }: { nodes: Node[] }) {
		historyStore.beginDrag();
		// Initialize last positions for all dragged nodes
		lastDraggedPositions.clear();
		for (const node of draggedNodes) {
			const snappedX = Math.round(node.position.x / GRID_SIZE) * GRID_SIZE;
			const snappedY = Math.round(node.position.y / GRID_SIZE) * GRID_SIZE;
			lastDraggedPositions.set(node.id, { x: snappedX, y: snappedY });
		}
	}

	// Handle node drag - reroute at discrete grid positions (only affected routes)
	function handleNodeDrag({ nodes: draggedNodes }: { nodes: Node[] }) {
		// Check if any node moved to a new grid position
		const changedNodeIds = new Set<string>();
		for (const node of draggedNodes) {
			// Skip non-block nodes (events, annotations don't affect routing)
			if (node.type !== 'pathview') continue;
			if (isAcausalJunctionNodeType((node.data as NodeInstance).type)) continue;

			const snappedX = Math.round(node.position.x / GRID_SIZE) * GRID_SIZE;
			const snappedY = Math.round(node.position.y / GRID_SIZE) * GRID_SIZE;
			const lastPos = lastDraggedPositions.get(node.id);

			if (!lastPos || lastPos.x !== snappedX || lastPos.y !== snappedY) {
				lastDraggedPositions.set(node.id, { x: snappedX, y: snappedY });
				changedNodeIds.add(node.id);

				// Incrementally update grid obstacle for this node
				const width = node.measured?.width ?? node.width ?? 80;
				const height = node.measured?.height ?? node.height ?? 40;
				routingStore.updateNodeBounds(node.id, {
					x: snappedX - width / 2,
					y: snappedY - height / 2,
					width,
					height
				});
			}
		}

		// Only recalculate routes connected to moved nodes
		if (changedNodeIds.size > 0) {
			const connections = get(graphStore.connections);
			routingStore.recalculateRoutesForNodes(changedNodeIds, connections, getPortInfo);
		}
	}

	// Handle node drag end - sync position back to store and finalize undo entry
	function handleNodeDragStop({ targetNode, nodes: draggedNodes }: { targetNode: Node | null; nodes: Node[]; event: MouseEvent | TouchEvent }) {
		// Clear drag position tracking
		lastDraggedPositions.clear();
		let movedJunctionId: string | null = null;

		if (targetNode?.id && targetNode?.position) {
			isSyncing = true;
			// Check node type and update appropriate store
			if (targetNode.type === 'eventNode') {
				if (graphStore.isAtRoot()) {
					eventStore.updateEventPosition(targetNode.id, targetNode.position);
				} else {
					graphStore.updateSubsystemEventPosition(targetNode.id, targetNode.position);
				}
			} else if (targetNode.type === 'annotation') {
				graphStore.updateAnnotationPosition(targetNode.id, targetNode.position);
			} else {
				graphStore.updateNodePosition(targetNode.id, targetNode.position);
				if (isAcausalJunctionNodeType((targetNode.data as NodeInstance).type)) {
					movedJunctionId = targetNode.id;
				}
			}
			isSyncing = false;
		}
		if (movedJunctionId) {
			graphStore.optimizeJunctionPorts(movedJunctionId);
		}
		historyStore.endDrag();

		// Update routing context and recalculate routes (final)
		const draggedRoutingNode = draggedNodes.some(
			(node) =>
				node.type === 'pathview' &&
				!isAcausalJunctionNodeType((node.data as NodeInstance).type)
		);
		if (draggedRoutingNode) {
			updateRoutingContext();
		}
	}

	// Handle node and edge delete
	function handleDelete({ nodes: deletedNodes, edges: deletedEdges }: { nodes: Node[]; edges: Edge[] }) {
		if (deletedNodes.length === 0 && deletedEdges.length === 0) return;

		isSyncing = true;

		// Wrap in historyStore.mutate for undo/redo support
		historyStore.mutate(() => {
			// Handle deleted nodes - distinguish between blocks, events, and annotations
			// Only remove if the item actually exists in the store (guards against false deletions from navigation)
			deletedNodes.forEach((node) => {
				if (node.type === 'eventNode') {
					if (graphStore.isAtRoot()) {
						if (eventStore.getEvent(node.id)) {
							eventStore.removeEvent(node.id);
						}
					} else {
						if (graphStore.getSubsystemEvent(node.id)) {
							graphStore.removeSubsystemEvent(node.id);
						}
					}
				} else if (node.type === 'annotation') {
					if (graphStore.getAnnotation(node.id)) {
						graphStore.removeAnnotation(node.id);
					}
				} else {
					if (graphStore.getNode(node.id)) {
						graphStore.removeNode(node.id);
						portCounts.delete(node.id);
					}
				}
			});

			// Handle deleted edges
			deletedEdges.forEach((edge) => {
				const currentConnections = get(graphStore.connections);
				let conn = currentConnections.find((c) => c.id === edge.id);

				// If ID doesn't match, try to find by source/target handles
				if (!conn && edge.sourceHandle && edge.targetHandle) {
					const sourceMatch = edge.sourceHandle.match(/-output-(\d+)$/);
					const targetMatch = edge.targetHandle.match(/-input-(\d+)$/);
					if (sourceMatch && targetMatch) {
						const sourcePortIndex = parseInt(sourceMatch[1], 10);
						const targetPortIndex = parseInt(targetMatch[1], 10);
						conn = currentConnections.find(
							(c) =>
								c.sourceNodeId === edge.source &&
								c.sourcePortIndex === sourcePortIndex &&
								c.targetNodeId === edge.target &&
								c.targetPortIndex === targetPortIndex
						);
					}
				}

				if (conn) {
					graphStore.removeConnection(conn.id);
				}
			});
		});

		// Filter out deleted nodes from current node arrays
		const deletedIds = new Set(deletedNodes.map(n => n.id));
		const remainingGraphNodeIds = new Set(get(graphStore.nodesArray).map((node) => node.id));
		blockNodes = blockNodes.filter(n => remainingGraphNodeIds.has(n.id));
		eventNodes = eventNodes.filter(n => !deletedIds.has(n.id));
		annotationNodes = annotationNodes.filter(n => !deletedIds.has(n.id));

		// Force sync edges from store after deletion
		const afterConnections = get(graphStore.connections);
		edges = afterConnections.map(toFlowEdge);

		isSyncing = false;
	}

	// Validate connections before they are created.
	// Blocks causal↔acausal mixing and cross-domain acausal connections.
	function isValidConnection(connection: FlowConnection): boolean {
		const { source, target, sourceHandle, targetHandle } = connection;
		if (!source || !target || source === target) return false;

		const graphNodes = get(graphStore.nodesArray);
		const sourceNode = graphNodes.find(n => n.id === source);
		const targetNode = graphNodes.find(n => n.id === target);
		if (!sourceNode || !targetNode) return false;

		const sourceDef = nodeRegistry.get(sourceNode.type);
		const targetDef = nodeRegistry.get(targetNode.type);
		if (!sourceDef || !targetDef) return false;

		const sourceIsAcausal = !!sourceDef.acausalDomain;
		const targetIsAcausal = !!targetDef.acausalDomain;

		// Both must be the same kind (causal↔causal or acausal↔acausal)
		if (sourceIsAcausal !== targetIsAcausal) return false;

		// Acausal connections must share the same physical domain
		if (sourceIsAcausal && sourceDef.acausalDomain !== targetDef.acausalDomain) return false;

		if (sourceIsAcausal) {
			const currentConnections = get(graphStore.connections);
			const sourcePortIndex = sourceHandle ? HANDLE_ID.parseIndex(sourceHandle, 'acausal') : null;
			const targetPortIndex = targetHandle ? HANDLE_ID.parseIndex(targetHandle, 'acausal') : null;

			const isPortOccupied = (nodeId: string, portIndex: number) =>
				currentConnections.some(
					(c) =>
						c.kind === 'acausal' &&
						(
							(c.sourceNodeId === nodeId && c.sourcePortIndex === portIndex) ||
							(c.targetNodeId === nodeId && c.targetPortIndex === portIndex)
						)
				);

			if (
				sourcePortIndex !== null &&
				isAcausalJunctionNodeType(sourceNode.type) &&
				isPortOccupied(source, sourcePortIndex)
			) {
				return false;
			}

			if (
				targetPortIndex !== null &&
				isAcausalJunctionNodeType(targetNode.type) &&
				isPortOccupied(target, targetPortIndex)
			) {
				return false;
			}
		}

		return true;
	}

	// Handle new connections
	function handleConnect(connection: FlowConnection) {
		if (!connection.source || !connection.target) return;
		if (!connection.sourceHandle || !connection.targetHandle) return;

		// Acausal connection: with ConnectionMode.Loose, both handles are source type (-acausal-N)
		const acausalSourceIndex = HANDLE_ID.parseIndex(connection.sourceHandle, 'acausal');
		const acausalTargetIndex = HANDLE_ID.parseIndex(connection.targetHandle, 'acausal');

		if (acausalSourceIndex !== null && acausalTargetIndex !== null) {
			historyStore.mutate(() => {
				graphStore.addConnection(
					connection.source!,
					acausalSourceIndex,
					connection.target!,
					acausalTargetIndex,
					'acausal'
				);
			});
			return;
		}

		const sourceMatch = connection.sourceHandle.match(/-output-(\d+)$/);
		const targetMatch = connection.targetHandle.match(/-input-(\d+)$/);

		if (sourceMatch && targetMatch) {
			historyStore.mutate(() => {
				const sourcePortIndex = parseInt(sourceMatch[1], 10);
				let targetPortIndex = parseInt(targetMatch[1], 10);

				// Check if the target port is already connected
				const currentConnections = get(graphStore.connections);
				const isPortOccupied = currentConnections.some(
					(c) => c.targetNodeId === connection.target && c.targetPortIndex === targetPortIndex
				);

				if (isPortOccupied) {
					// Find the first available port instead
					const availablePort = findFirstAvailableInputPort(connection.target);

					if (availablePort !== null) {
						// Use the first available port
						targetPortIndex = availablePort;
					} else {
						// No available port - check if we can create a new one
						const graphNodes = get(graphStore.nodesArray);
						const targetNode = graphNodes.find((n) => n.id === connection.target);
						if (!targetNode) return;

						const typeDef = nodeRegistry.get(targetNode.type);
						if (!typeDef || typeDef.ports.maxInputs !== null) {
							// Can't create new port, abort
							return;
						}

						// Create a new port and use it
						graphStore.addInputPort(connection.target);
						targetPortIndex = targetNode.inputs.length; // The new port index
					}
				}

				// addConnection uses current navigation context automatically
				graphStore.addConnection(
					connection.source,
					sourcePortIndex,
					connection.target,
					targetPortIndex
				);
			});
		}
	}

	function handleConnectStart(event: MouseEvent | TouchEvent, params: OnConnectStartParams) {
		const sourceNodeId = params.nodeId;
		const handleId = params.handleId;
		const sourcePortIndex = handleId ? HANDLE_ID.parseIndex(handleId, 'acausal') : null;
		if (!sourceNodeId || sourcePortIndex === null) {
			portConnectionDrag = {
				active: false,
				sourceNodeId: null,
				sourcePortIndex: null,
				sourceFlowPosition: null,
				sourceHandlePosition: null,
				domain: null,
				domainColor: ACAUSAL_DOMAIN_COLORS.default,
				junctionType: null
			};
			return;
		}

		const graphNodes = get(graphStore.nodesArray);
		const sourceNode = graphNodes.find((node) => node.id === sourceNodeId);
		if (!sourceNode || isAcausalJunctionNodeType(sourceNode.type)) {
			portConnectionDrag = {
				active: false,
				sourceNodeId: null,
				sourcePortIndex: null,
				sourceFlowPosition: null,
				sourceHandlePosition: null,
				domain: null,
				domainColor: ACAUSAL_DOMAIN_COLORS.default,
				junctionType: null
			};
			return;
		}

		const sourceDef = nodeRegistry.get(sourceNode.type);
		const domain = sourceDef?.acausalDomain;
		const junctionType = domain ? getAcausalJunctionType(domain) : null;
		if (!domain || !junctionType) {
			portConnectionDrag = {
				active: false,
				sourceNodeId: null,
				sourcePortIndex: null,
				sourceFlowPosition: null,
				sourceHandlePosition: null,
				domain: null,
				domainColor: ACAUSAL_DOMAIN_COLORS.default,
				junctionType: null
			};
			return;
		}

		const handleEl = (event.target as HTMLElement | null)?.closest('.svelte-flow__handle') as HTMLElement | null;
		const rect = handleEl?.getBoundingClientRect();
		const sourceScreenPosition = rect
			? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
			: mousePosition;
		const sourceFlowPosition = screenToFlow(sourceScreenPosition);
		const handlePos = handleEl?.dataset.handlepos;
		const sourceHandlePosition =
			handlePos === 'left'
				? Position.Left
				: handlePos === 'right'
					? Position.Right
					: handlePos === 'top'
						? Position.Top
						: handlePos === 'bottom'
							? Position.Bottom
							: null;

		portConnectionDrag = {
			active: true,
			sourceNodeId,
			sourcePortIndex,
			sourceFlowPosition,
			sourceHandlePosition,
			domain,
			domainColor: ACAUSAL_DOMAIN_COLORS[domain] ?? ACAUSAL_DOMAIN_COLORS.default,
			junctionType
		};
	}

	function handleConnectEnd(_event: MouseEvent | TouchEvent, connectionState: FinalConnectionState) {
		const preview = portConnectionBranchPreview;
		portConnectionDrag = {
			active: false,
			sourceNodeId: null,
			sourcePortIndex: null,
			sourceFlowPosition: null,
			sourceHandlePosition: null,
			domain: null,
			domainColor: ACAUSAL_DOMAIN_COLORS.default,
			junctionType: null
		};
		portConnectionBranchPreview = null;
		if (!preview || connectionState.toHandle) return;

		historyStore.mutate(() => {
			if (preview.existingJunctionNodeId) {
				graphStore.addConnection(
					preview.dragSourceNodeId,
					preview.dragSourcePortIndex,
					preview.existingJunctionNodeId,
					preview.branchPort,
					'acausal'
				);
				return;
			}

			const currentConnections = get(graphStore.connections);
			if (!preview.edgeId || !currentConnections.some((connection) => connection.id === preview.edgeId)) {
				return;
			}

			if (
				preview.sourceNodeId === null ||
				preview.sourcePortIndex === null ||
				preview.targetNodeId === null ||
				preview.targetPortIndex === null ||
				preview.sourceJunctionPort === null ||
				preview.targetJunctionPort === null
			) return;

			const junctionNode = graphStore.splitAcausalConnectionWithJunction(
				preview.edgeId,
				preview.junctionType,
				preview.junctionFlowPosition,
				preview.sourceJunctionPort,
				preview.targetJunctionPort
			);
			if (!junctionNode) return;

			graphStore.addConnection(
				preview.dragSourceNodeId,
				preview.dragSourcePortIndex,
				junctionNode.id,
				preview.branchPort,
				'acausal'
			);
		});
	}

	function resolveBranchDropTarget(event: MouseEvent): { nodeId: string; portIndex: number } | null {
		const hoveredPortIndex = currentHoveredHandle
			? HANDLE_ID.parseIndex(currentHoveredHandle.handleId, 'acausal')
			: null;
		if (currentHoveredHandle && hoveredPortIndex !== null) {
			return { nodeId: currentHoveredHandle.nodeId, portIndex: hoveredPortIndex };
		}

		const handleEl = document
			.elementFromPoint(event.clientX, event.clientY)
			?.closest('.svelte-flow__handle') as HTMLElement | null;
		if (handleEl) {
			const nodeId = handleEl.dataset.nodeid;
			const handleId = handleEl.dataset.handleid;
			if (nodeId && handleId) {
				const portIndex = HANDLE_ID.parseIndex(handleId, 'acausal');
				if (portIndex !== null) {
					return { nodeId, portIndex };
				}
			}
		}

		const nodeEl = document
			.elementFromPoint(event.clientX, event.clientY)
			?.closest('.svelte-flow__node') as HTMLElement | null;
		const nodeId = nodeEl?.dataset.id;
		if (!nodeEl || !nodeId) return null;

		const graphNodes = get(graphStore.nodesArray);
		const targetNode = graphNodes.find((node) => node.id === nodeId);
		if (!targetNode || !isAcausalJunctionNodeType(targetNode.type)) return null;

		const preferredPosition = getPreferredJunctionDropPosition(nodeEl, event.clientX, event.clientY);
		const portIndex = getAvailableJunctionBranchPort(nodeId, preferredPosition);
		return portIndex === null ? null : { nodeId, portIndex };
	}

	function isValidBranchDropTarget(target: { nodeId: string; portIndex: number }): boolean {
		if (branchDrag.mode === 'junction' && target.nodeId === branchDrag.junctionNodeId) {
			return false;
		}
		if (
			target.nodeId === branchDrag.sourceNodeId && target.portIndex === branchDrag.sourcePortIndex ||
			target.nodeId === branchDrag.targetNodeId && target.portIndex === branchDrag.targetPortIndex
		) {
			return false;
		}

		const graphNodes = get(graphStore.nodesArray);
		const targetNode = graphNodes.find((node) => node.id === target.nodeId);
		if (!targetNode) return false;

		const targetDef = nodeRegistry.get(targetNode.type);
		if (!targetDef?.acausalDomain || targetDef.acausalDomain !== branchDrag.domain) {
			return false;
		}

		if (isAcausalJunctionNodeType(targetNode.type)) {
			const currentConnections = get(graphStore.connections);
			const targetPortOccupied = currentConnections.some(
				(connection) =>
					connection.kind === 'acausal' &&
					(
						(connection.sourceNodeId === target.nodeId && connection.sourcePortIndex === target.portIndex) ||
						(connection.targetNodeId === target.nodeId && connection.targetPortIndex === target.portIndex)
					)
			);
			if (targetPortOccupied) return false;
		}

		return true;
	}

	function handleGlobalPointerMove(event: PointerEvent) {
		mousePosition = { x: event.clientX, y: event.clientY };
		if (!branchDrag.active) return;
		branchDragStore.updatePointer({ x: event.clientX, y: event.clientY });
	}

	function handleBranchDragPointerUp(event: PointerEvent) {
		if (!branchDrag.active) return;

		branchDragStore.updatePointer({ x: event.clientX, y: event.clientY });
		const dropTarget = resolveBranchDropTarget(event);
		const wireDropPreview = dropTarget ? null : resolveBranchWireDropPreview();
		const previewSourcePosition = getBranchPreviewSourcePosition();
		const branchPort =
			branchDrag.mode === 'junction' && branchDrag.junctionNodeId
				? getAvailableJunctionBranchPort(branchDrag.junctionNodeId, previewSourcePosition)
				: getBranchJunctionPort(previewSourcePosition);

		if (
			dropTarget &&
			branchPort !== null &&
			isValidBranchDropTarget(dropTarget)
		) {
			historyStore.mutate(() => {
				if (branchDrag.mode === 'edge') {
					if (
						!branchDrag.edgeId ||
						!branchDrag.junctionType ||
						!branchDrag.sourceNodeId ||
						branchDrag.sourcePortIndex === null ||
						!branchDrag.targetNodeId ||
						branchDrag.targetPortIndex === null ||
						!branchDrag.junctionFlowPosition ||
						branchDrag.sourceJunctionPort === null ||
						branchDrag.targetJunctionPort === null
					) {
						return;
					}

					const currentConnections = get(graphStore.connections);
					if (!currentConnections.some((connection) => connection.id === branchDrag.edgeId)) {
						return;
					}

					const junctionNode = graphStore.splitAcausalConnectionWithJunction(
						branchDrag.edgeId,
						branchDrag.junctionType,
						branchDrag.junctionFlowPosition,
						branchDrag.sourceJunctionPort,
						branchDrag.targetJunctionPort
					);
					if (!junctionNode) return;

					graphStore.addConnection(
						junctionNode.id,
						branchPort,
						dropTarget.nodeId,
						dropTarget.portIndex,
						'acausal'
					);
					return;
				}

				if (branchDrag.mode === 'junction' && branchDrag.junctionNodeId) {
					graphStore.addConnection(
						branchDrag.junctionNodeId,
						branchPort,
						dropTarget.nodeId,
						dropTarget.portIndex,
						'acausal'
					);
				}
			});
		} else if (wireDropPreview && branchPort !== null) {
			historyStore.mutate(() => {
				let sourceJunctionNodeId: string | null = null;

				if (branchDrag.mode === 'edge') {
					if (
						!branchDrag.edgeId ||
						!branchDrag.junctionType ||
						!branchDrag.sourceNodeId ||
						branchDrag.sourcePortIndex === null ||
						!branchDrag.targetNodeId ||
						branchDrag.targetPortIndex === null ||
						!branchDrag.junctionFlowPosition ||
						branchDrag.sourceJunctionPort === null ||
						branchDrag.targetJunctionPort === null
					) {
						return;
					}

					const currentConnections = get(graphStore.connections);
					if (!currentConnections.some((connection) => connection.id === branchDrag.edgeId)) {
						return;
					}

					const sourceJunctionNode = graphStore.splitAcausalConnectionWithJunction(
						branchDrag.edgeId,
						branchDrag.junctionType,
						branchDrag.junctionFlowPosition,
						branchDrag.sourceJunctionPort,
						branchDrag.targetJunctionPort
					);
					if (!sourceJunctionNode) return;
					sourceJunctionNodeId = sourceJunctionNode.id;
				} else if (branchDrag.mode === 'junction' && branchDrag.junctionNodeId) {
					sourceJunctionNodeId = branchDrag.junctionNodeId;
				}

				if (!sourceJunctionNodeId) return;

				if (wireDropPreview.existingJunctionNodeId) {
					graphStore.addConnection(
						sourceJunctionNodeId,
						branchPort,
						wireDropPreview.existingJunctionNodeId,
						wireDropPreview.branchPort,
						'acausal'
					);
					return;
				}

				const currentConnections = get(graphStore.connections);
				if (
					!wireDropPreview.edgeId ||
					!wireDropPreview.sourceNodeId ||
					wireDropPreview.sourcePortIndex === null ||
					!wireDropPreview.targetNodeId ||
					wireDropPreview.targetPortIndex === null ||
					wireDropPreview.sourceJunctionPort === null ||
					wireDropPreview.targetJunctionPort === null ||
					!currentConnections.some((connection) => connection.id === wireDropPreview.edgeId)
				) {
					return;
				}

				const targetJunctionType =
					branchDrag.junctionType ?? (branchDrag.domain ? getAcausalJunctionType(branchDrag.domain) : null);
				if (!targetJunctionType) return;

				const targetJunctionNode = graphStore.splitAcausalConnectionWithJunction(
					wireDropPreview.edgeId,
					targetJunctionType,
					wireDropPreview.junctionFlowPosition,
					wireDropPreview.sourceJunctionPort,
					wireDropPreview.targetJunctionPort
				);
				if (!targetJunctionNode) return;

				graphStore.addConnection(
					sourceJunctionNodeId,
					branchPort,
					targetJunctionNode.id,
					wireDropPreview.branchPort,
					'acausal'
				);
			});
		}

		branchWireDropPreview = null;
		branchDragStore.cancel();
		setTimeout(() => branchDragStore.clearContextMenuSuppression(), 0);
	}

	// Handle selection changes - sync from SvelteFlow to stores
	// Uses direct setters to avoid triggering back to SvelteFlow
	function handleSelectionChange({ nodes: selectedNodes }: { nodes: Node[]; edges: Edge[] }) {
		const selectedBlockIds = new Set<string>();
		const selectedEventIdSet = new Set<string>();

		selectedNodes?.forEach((node) => {
			if (node.type === 'eventNode') {
				selectedEventIdSet.add(node.id);
			} else {
				// Both regular nodes and annotations go into selectedBlockIds
				selectedBlockIds.add(node.id);
			}
		});

		// Update stores directly (bypasses trigger-based functions)
		graphSelectedNodeIds.set(selectedBlockIds);
		setEventSelection(selectedEventIdSet);
	}

	// Track file drag state for drop zone indicator
	let isFileDragOver = $state(false);
	let dragCounter = 0; // Counter to handle nested elements

	function hasFiles(event: DragEvent): boolean {
		return event.dataTransfer?.types.includes('Files') ?? false;
	}

	function handleDragEnter(event: DragEvent) {
		if (hasFiles(event)) {
			dragCounter++;
			isFileDragOver = true;
		}
	}

	function handleDragLeave(event: DragEvent) {
		if (hasFiles(event)) {
			dragCounter--;
			if (dragCounter === 0) {
				isFileDragOver = false;
			}
		}
	}

	// Handle drop from node library - delegates to registered handler inside SvelteFlow context
	function handleDrop(event: DragEvent) {
		event.preventDefault();
		// Reset file drag state
		dragCounter = 0;
		isFileDragOver = false;
		dropTargetBridge.handleDrop(event);
	}

	function handleDragOver(event: DragEvent) {
		event.preventDefault();
		if (event.dataTransfer) {
			event.dataTransfer.dropEffect = 'copy';
		}
	}

	// Reference to flow canvas for coordinate conversion
	let canvasEl: HTMLDivElement;

	// Context menu handlers - SvelteFlow passes { event, node/edge } objects
	function handleNodeContextMenu({ event, node }: { event: MouseEvent; node: Node }) {
		event.preventDefault();
		if (branchDrag.suppressContextMenu) return;
		if (isAcausalJunctionNodeType((node.data as NodeInstance).type)) return;

		// Check if this is an event node
		if (node.type === 'eventNode') {
			contextMenuStore.openForEvent(node.id, { x: event.clientX, y: event.clientY });
			return;
		}

		// Check if this is an annotation
		if (node.type === 'annotation') {
			contextMenuStore.openForAnnotation(node.id, { x: event.clientX, y: event.clientY });
			return;
		}

		// Check if there are multiple selected nodes
		const selectedNodes = nodes.filter(n => n.selected);
		if (selectedNodes.length > 1 && selectedNodes.some(n => n.id === node.id)) {
			// Multiple selection - show selection context menu
			contextMenuStore.openForSelection(
				selectedNodes.map(n => n.id),
				{ x: event.clientX, y: event.clientY }
			);
		} else {
			// Single node context menu
			contextMenuStore.openForNode(node.id, { x: event.clientX, y: event.clientY });
		}
	}

	function handleEdgeContextMenu({ event, edge }: { event: MouseEvent; edge: Edge }) {
		event.preventDefault();
		if ((edge.data as { domain?: string } | undefined)?.domain) return;
		if (branchDrag.suppressContextMenu) return;
		contextMenuStore.openForEdge(edge.id, { x: event.clientX, y: event.clientY });
	}

	function handlePaneContextMenu({ event }: { event: MouseEvent }) {
		event.preventDefault();
		if (branchDrag.suppressContextMenu) return;
		contextMenuStore.openForCanvas({ x: event.clientX, y: event.clientY });
	}

	function handleCanvasDoubleClick(event: MouseEvent) {
		// Only trigger fit view if clicking on the canvas background (not on nodes/edges)
		const target = event.target as HTMLElement;
		if (target.closest('.svelte-flow__pane')) {
			triggerFitView();
		}
	}

	$effect(() => {
		portConnectionBranchPreview =
			currentHoveredHandle || !portConnectionDrag.active ? null : resolvePortConnectionBranchPreview();
	});

	$effect(() => {
		branchWireDropPreview =
			currentHoveredHandle || !branchDrag.active ? null : resolveBranchWireDropPreview();
	});
</script>

<svelte:window onkeydown={handleKeydown} onpointermove={handleGlobalPointerMove} onpointerup={handleBranchDragPointerUp} />

<div
	bind:this={canvasEl}
	class="flow-canvas"
	role="application"
	aria-label="Flow canvas"
	ondragover={handleDragOver}
	ondragenter={handleDragEnter}
	ondragleave={handleDragLeave}
	ondblclick={handleCanvasDoubleClick}
	onmousemove={handleMouseMove}
>
	{#if branchDrag.active && getBranchPreviewPath() && branchDrag.junctionScreenPosition}
		<svg class="branch-preview-overlay" aria-hidden="true">
			<circle
				cx={branchDrag.junctionScreenPosition.x}
				cy={branchDrag.junctionScreenPosition.y}
				r={JUNCTION.dotSize / 2}
				fill={branchDrag.domainColor || 'var(--accent)'}
				class="junction-preview-dot"
				style="--junction-dot-color: {branchDrag.domainColor || 'var(--accent)'};"
			/>
			<path
				d={getBranchPreviewPath()}
				class="branch-preview-path"
				style="stroke: {branchDrag.domainColor || 'var(--accent)'};"
			/>
		</svg>
	{/if}

	{#if portConnectionBranchPreview}
		<svg class="branch-preview-overlay" aria-hidden="true">
			<circle
				cx={portConnectionBranchPreview.junctionScreenPosition.x}
				cy={portConnectionBranchPreview.junctionScreenPosition.y}
				r={JUNCTION.dotSize / 2}
				fill={portConnectionBranchPreview.domainColor}
				class="junction-preview-dot"
				style="--junction-dot-color: {portConnectionBranchPreview.domainColor};"
			/>
		</svg>
	{/if}

	{#if branchWireDropPreview}
		<svg class="branch-preview-overlay" aria-hidden="true">
			<circle
				cx={branchWireDropPreview.junctionScreenPosition.x}
				cy={branchWireDropPreview.junctionScreenPosition.y}
				r={JUNCTION.dotSize / 2}
				fill={branchDrag.domainColor || 'var(--accent)'}
				class="junction-preview-dot"
				style="--junction-dot-color: {branchDrag.domainColor || 'var(--accent)'};"
			/>
		</svg>
	{/if}

	{#if isFileDragOver}
		<div class="drop-zone-overlay">
			<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
				<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
				<polyline points="7 10 12 15 17 10"/>
				<line x1="12" y1="15" x2="12" y2="3"/>
			</svg>
		</div>
	{/if}
	<SvelteFlow
		bind:nodes
		bind:edges
		{nodeTypes}
		{edgeTypes}
		onconnect={handleConnect}
		onconnectstart={handleConnectStart}
		onconnectend={handleConnectEnd}
		{isValidConnection}
		connectionMode={ConnectionMode.Loose}
		onnodedragstart={handleNodeDragStart}
		onnodedrag={handleNodeDrag}
		onnodedragstop={handleNodeDragStop}
		ondelete={handleDelete}
		onselectionchange={handleSelectionChange}
		ondrop={(e: any) => handleDrop(e.event || e)}
		ondragover={(e: any) => handleDragOver(e.event || e)}
		onnodecontextmenu={handleNodeContextMenu}
		onedgecontextmenu={handleEdgeContextMenu}
		onpanecontextmenu={handlePaneContextMenu}
		nodeOrigin={[0.5, 0.5]}
		{...{ snapToGrid: true, snapGrid: SNAP_GRID } as any}
		deleteKeyCode={['Delete', 'Backspace']}
		selectionKeyCode={['Shift']}
		multiSelectionKeyCode={['Shift', 'Meta', 'Control']}
		{colorMode}
		connectOnClick
		edgesReconnectable
		edgesFocusable
		edgesSelectable
		zoomOnDoubleClick={false}
		proOptions={{ hideAttribution: true }}
	>
		<FlowUpdater pendingUpdates={pendingNodeUpdates} onUpdatesProcessed={clearPendingUpdates} />
		<Background variant={BackgroundVariant.Dots} gap={BACKGROUND_GAP} size={1} />
	</SvelteFlow>
</div>

<style>
	.flow-canvas {
		width: 100%;
		height: 100%;
		position: relative;
	}

	.branch-preview-overlay {
		position: fixed;
		inset: 0;
		width: 100vw;
		height: 100vh;
		pointer-events: none;
		z-index: 20;
		overflow: visible;
	}

	.branch-preview-path {
		fill: none;
		stroke-width: 1.75;
		stroke-dasharray: 5 5;
	}

	.junction-preview-dot {
		stroke: var(--surface);
		stroke-width: 2;
		filter: drop-shadow(0 0 4px color-mix(in srgb, var(--junction-dot-color, var(--accent)) 45%, transparent));
	}

	.drop-zone-overlay {
		position: absolute;
		inset: 0;
		background: color-mix(in srgb, var(--accent) 10%, transparent);
		z-index: 1000;
		display: flex;
		align-items: center;
		justify-content: center;
		pointer-events: none;
		color: var(--accent);
	}

	/* Modern dark theme */
	:global(.svelte-flow) {
		--xy-background-color: var(--surface);
		--xy-node-background-color: var(--surface-raised);
		--xy-node-border-radius: 12px;
		--xy-handle-background-color: var(--edge);
		--xy-edge-stroke: var(--edge);
		--xy-edge-stroke-selected: var(--accent);
		--xy-edge-stroke-width: 1;
		--xy-connectionline-stroke: var(--accent);
		--xy-connectionline-stroke-width: 1;
	}

	:global(.svelte-flow__background) {
		background: var(--surface);
	}

	:global(.svelte-flow__background pattern circle) {
		fill: var(--grid-dot);
	}

	/* Edge styling */
	:global(.svelte-flow__edge-path) {
		stroke: var(--edge);
		stroke-width: 1;
		transition: stroke 0.15s ease;
		cursor: pointer;
	}

	/* Invisible wider path for easier clicking */
	:global(.svelte-flow__edge-interaction) {
		stroke-width: 20;
		stroke: transparent;
		cursor: pointer;
	}

	:global(.svelte-flow__edge:hover .svelte-flow__edge-path) {
		stroke: var(--accent, #0070C0);
		stroke-width: 1;
	}

	:global(.svelte-flow__edge.selected .svelte-flow__edge-path) {
		stroke: var(--accent, #0070C0);
		stroke-width: 1.5;
	}

	/* Connection line */
	:global(.svelte-flow__connection-path) {
		stroke: var(--accent, #0070C0);
		stroke-width: 1;
		stroke-dasharray: 5 5;
		animation: dash 0.5s linear infinite;
	}

	@keyframes dash {
		to {
			stroke-dashoffset: -10;
		}
	}

	/* Selection box (drag-to-select rectangle) */
	:global(.svelte-flow__selection) {
		background: color-mix(in srgb, var(--accent) 10%, transparent);
		border: 1px solid var(--accent);
		border-radius: 4px;
	}

	/* Hide the bounding box around selected nodes (but keep drag-select rectangle) */
	:global(.svelte-flow__selection-wrapper .svelte-flow__selection) {
		background: transparent !important;
		border: none !important;
	}
</style>
