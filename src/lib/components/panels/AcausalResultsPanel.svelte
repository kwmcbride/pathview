<script module lang="ts">
	let persistedExpandedGroupKeys: string[] = [];
	let persistedSelectedSignalKeys: string[] = [];
	let persistedLabelSignature = '';
	let persistedShowLegend = true;
</script>

<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import Icon from '$lib/components/icons/Icon.svelte';
	import { simulationState, type SimulationResult } from '$lib/pyodide/bridge';
	import { settingsStore } from '$lib/stores/settings';
	import { themeStore } from '$lib/stores/theme';
	import { getBaseLayout, createEmptyLayout, PLOTLY_CONFIG } from '$lib/plotting/renderers/plotly';
	import { decimateMinMax } from '$lib/plotting/core/utils';

	interface SignalLeaf {
		key: string;
		label: string;
		shortLabel: string;
		index: number;
		path: string[];
	}

	interface GroupNode {
		key: string;
		label: string;
		depth: number;
		children: GroupNode[];
		leaves: SignalLeaf[];
	}

	type TreeRow =
		| { kind: 'group'; key: string; label: string; depth: number }
		| { kind: 'leaf'; leaf: SignalLeaf; depth: number };

	type ScopeSeries = NonNullable<SimulationResult['scopeData'][string]>;

	const ACAUSAL_SCOPE_ID = '_acausal_net';
	const TRACE_COLORS = [
		'#4f8cff',
		'#00b894',
		'#f39c12',
		'#e74c3c',
		'#9b59b6',
		'#16a085',
		'#e67e22',
		'#e84393',
		'#2ecc71',
		'#3498db'
	];

	let simResult = $state<SimulationResult | null>(null);
	let resultHistory = $state<SimulationResult[]>([]);
	let ghostTraces = $state(0);

	let plotDiv: HTMLDivElement;
	let Plotly: typeof import('plotly.js-dist-min') | null = null;
	let resizeObserver: ResizeObserver | null = null;

	let expandedGroups = $state<Set<string>>(new Set(persistedExpandedGroupKeys));
	let selectedSignals = $state<Set<string>>(new Set(persistedSelectedSignalKeys));
	let labelSignature = persistedLabelSignature;
	let showLegend = $state(persistedShowLegend);
	let isStreaming = $state(false);

	let streamingInitialized = false;
	let renderedTimeLength = 0;
	let ghostTraceCount = 0;
	let renderedSelectionSignature = '';
	let renderedGhostHistoryLength = 0;
	let renderedShowLegend = persistedShowLegend;
	let wasStreaming = false;

	const unsubscribeSimulation = simulationState.subscribe((state) => {
		simResult = state.result;
		resultHistory = state.resultHistory;
		const newIsStreaming = state.phase === 'running';

		if (state.phase === 'starting') {
			resetPlotRenderState();
		} else if (newIsStreaming && !wasStreaming) {
			resetPlotRenderState();
		} else if (!newIsStreaming && wasStreaming) {
			resetPlotRenderState();
		}

		wasStreaming = newIsStreaming;
		isStreaming = newIsStreaming;

		if (Plotly && plotDiv) {
			renderPlot();
		}
	});

	const unsubscribeSettings = settingsStore.subscribe((state) => {
		ghostTraces = state.ghostTraces ?? 0;
	});

	const unsubscribeTheme = themeStore.subscribe(() => {
		if (Plotly && plotDiv) {
			renderPlot();
		}
	});

	const acausalScope = $derived(simResult?.scopeData?.[ACAUSAL_SCOPE_ID] ?? null);
	const signalLeaves = $derived(buildSignalLeaves(acausalScope));
	const tree = $derived(buildTree(signalLeaves));
	const treeRows = $derived(flattenTree(tree, expandedGroups));
	const selectedLeaves = $derived(signalLeaves.filter((leaf) => selectedSignals.has(leaf.key)));

	$effect(() => {
		const signature = signalLeaves.map((leaf) => leaf.key).join('|');
		if (signature === labelSignature) return;
		labelSignature = signature;

		expandedGroups = new Set();

		const validKeys = new Set(signalLeaves.map((leaf) => leaf.key));
		const nextSelected = new Set(
			[...selectedSignals].filter((key) => validKeys.has(key))
		);
		if (nextSelected.size === 0 && signalLeaves.length > 0) {
			nextSelected.add(signalLeaves[0].key);
		}
		selectedSignals = nextSelected;
	});

	$effect(() => {
		persistedExpandedGroupKeys = [...expandedGroups];
		persistedSelectedSignalKeys = [...selectedSignals];
		persistedLabelSignature = labelSignature;
		persistedShowLegend = showLegend;
	});

	$effect(() => {
		selectedLeaves;
		ghostTraces;
		showLegend;
		if (Plotly && plotDiv) {
			renderPlot();
		}
	});

	onMount(async () => {
		Plotly = await import('plotly.js-dist-min');
		renderPlot();

		resizeObserver = new ResizeObserver(() => {
			if (Plotly && plotDiv) {
				Plotly.Plots.resize(plotDiv);
			}
		});
		resizeObserver.observe(plotDiv);
	});

	onDestroy(() => {
		unsubscribeSimulation();
		unsubscribeSettings();
		unsubscribeTheme();
		resizeObserver?.disconnect();
		if (Plotly && plotDiv) {
			Plotly.purge(plotDiv);
		}
	});

	function buildSignalLeaves(
		scope: SimulationResult['scopeData'][string] | null
	): SignalLeaf[] {
		if (!scope) return [];
		const labels = scope.labels ?? [];
		return scope.signals.map((_signal, index) => {
			const label = labels[index] || `state_${index}`;
			const parts = label.split('.').filter(Boolean);
			return {
				key: label,
				label,
				shortLabel: parts.length > 1 ? parts[parts.length - 1] : label,
				index,
				path: parts.length > 1 ? parts.slice(0, -1) : []
			};
		});
	}

	function buildTree(leaves: SignalLeaf[]): GroupNode[] {
		const root = new Map<string, GroupNode>();

		for (const leaf of leaves) {
			if (leaf.path.length === 0) {
				let statesGroup = root.get('__root_signals__');
				if (!statesGroup) {
					statesGroup = {
						key: '__root_signals__',
						label: 'Signals',
						depth: 0,
						children: [],
						leaves: []
					};
					root.set(statesGroup.key, statesGroup);
				}
				statesGroup.leaves.push(leaf);
				continue;
			}

			let currentMap = root;
			let currentNode: GroupNode | null = null;
			for (const [depth, segment] of leaf.path.entries()) {
				const key = leaf.path.slice(0, depth + 1).join('.');
				let nextNode = currentMap.get(key);
				if (!nextNode) {
					nextNode = {
						key,
						label: segment,
						depth,
						children: [],
						leaves: []
					};
					currentMap.set(key, nextNode);
					if (currentNode) {
						currentNode.children.push(nextNode);
					}
				}
				currentNode = nextNode;
				currentMap = new Map(currentNode.children.map((child) => [child.key, child]));
			}
			if (currentNode) {
				currentNode.leaves.push(leaf);
			}
		}

		return sortGroups([...root.values()]);
	}

	function sortGroups(groups: GroupNode[]): GroupNode[] {
		return groups
			.map((group) => ({
				...group,
				children: sortGroups(group.children),
				leaves: [...group.leaves].sort((a, b) => a.shortLabel.localeCompare(b.shortLabel))
			}))
			.sort((a, b) => a.label.localeCompare(b.label));
	}

	function flattenTree(groups: GroupNode[], expanded: Set<string>): TreeRow[] {
		const rows: TreeRow[] = [];

		function walk(group: GroupNode) {
			rows.push({ kind: 'group', key: group.key, label: group.label, depth: group.depth });
			if (!expanded.has(group.key)) return;
			for (const child of group.children) {
				walk(child);
			}
			for (const leaf of group.leaves) {
				rows.push({ kind: 'leaf', leaf, depth: group.depth + 1 });
			}
		}

		for (const group of groups) {
			walk(group);
		}
		return rows;
	}

	function collectGroupKeys(groups: GroupNode[]): string[] {
		const keys: string[] = [];
		function walk(group: GroupNode) {
			keys.push(group.key);
			for (const child of group.children) {
				walk(child);
			}
		}
		for (const group of groups) {
			walk(group);
		}
		return keys;
	}

	function toggleGroup(key: string): void {
		const next = new Set(expandedGroups);
		if (next.has(key)) next.delete(key);
		else next.add(key);
		expandedGroups = next;
	}

	function toggleSignal(key: string): void {
		const next = new Set(selectedSignals);
		if (next.has(key)) next.delete(key);
		else next.add(key);
		selectedSignals = next;
	}

	function selectAllSignals(): void {
		selectedSignals = new Set(signalLeaves.map((leaf) => leaf.key));
	}

	function clearSignals(): void {
		selectedSignals = new Set();
	}

	function toggleLegend(): void {
		showLegend = !showLegend;
	}

	function resetPlotRenderState(): void {
		streamingInitialized = false;
		renderedTimeLength = 0;
		ghostTraceCount = 0;
		renderedSelectionSignature = '';
		renderedGhostHistoryLength = 0;
		renderedShowLegend = showLegend;
	}

	function buildGhostOpacity(historyIndex: number, total: number): number {
		if (total <= 0) return 0.2;
		return 0.12 + ((historyIndex + 1) / total) * 0.22;
	}

	function buildSelectionSignature(leaves: SignalLeaf[]): string {
		return leaves.map((leaf) => leaf.key).join('|');
	}

	function buildGhostHistory(): ScopeSeries[] {
		return resultHistory
			.slice(0, ghostTraces)
			.map((result) => result.scopeData?.[ACAUSAL_SCOPE_ID])
			.filter((value): value is ScopeSeries => value != null);
	}

	function buildPlotLayout(): Partial<Plotly.Layout> {
		const baseLayout = getBaseLayout();
		return {
			...baseLayout,
			xaxis: {
				...baseLayout.xaxis,
				title: { text: 'Time (s)', font: { size: 11 }, standoff: 10 }
			},
			yaxis: {
				...baseLayout.yaxis,
				title: { text: 'Acausal signal value', font: { size: 11 }, standoff: 5 }
			},
			showlegend: showLegend,
			legend: {
				...baseLayout.legend,
				itemsizing: 'constant'
			},
			hovermode: 'closest'
		};
	}

	function buildGhostTrace(
		ghost: ScopeSeries,
		leaf: SignalLeaf,
		color: string,
		opacity: number
	): Partial<Plotly.ScatterData> | null {
		const ghostSignal = ghost.signals[leaf.index];
		if (!ghostSignal || ghost.time.length === 0) return null;

		const decimated = decimateMinMax(ghost.time, ghostSignal);
		return {
			x: decimated.x,
			y: decimated.y,
			type: 'scatter',
			mode: 'lines',
			name: leaf.label,
			showlegend: false,
			hoverinfo: 'skip',
			opacity,
			line: {
				color,
				width: 1
			}
		};
	}

	function buildMainTrace(leaf: SignalLeaf, scope: ScopeSeries, color: string): Partial<Plotly.ScatterData> {
		return {
			x: scope.time,
			y: scope.signals[leaf.index] ?? [],
			type: 'scatter',
			mode: 'lines',
			name: leaf.label,
			line: {
				color,
				width: 1.8
			},
			hovertemplate:
				`<b style="color:${color}">${leaf.label}</b><br>` +
				't = %{x:.4g}<br>y = %{y:.4g}<extra></extra>'
		};
	}

	function buildPlotTraces(scope: ScopeSeries, history: ScopeSeries[]): Partial<Plotly.ScatterData>[] {
		const traces: Partial<Plotly.ScatterData>[] = [];

		for (let historyIndex = history.length - 1; historyIndex >= 0; historyIndex -= 1) {
			const ghost = history[historyIndex];
			const opacity = buildGhostOpacity(history.length - historyIndex - 1, history.length);
			selectedLeaves.forEach((leaf, leafIndex) => {
				const color = TRACE_COLORS[leafIndex % TRACE_COLORS.length];
				const trace = buildGhostTrace(ghost, leaf, color, opacity);
				if (trace) {
					traces.push(trace);
				}
			});
		}

		ghostTraceCount = traces.length;

		selectedLeaves.forEach((leaf, leafIndex) => {
			const color = TRACE_COLORS[leafIndex % TRACE_COLORS.length];
			traces.push(buildMainTrace(leaf, scope, color));
		});

		return traces;
	}

	function renderScopePlot(scope: ScopeSeries): void {
		if (!Plotly || !plotDiv) return;

		const history = buildGhostHistory();
		const currentTimeLength = scope.time.length;
		const selectionSignature = buildSelectionSignature(selectedLeaves);

		const canExtend =
			isStreaming &&
			streamingInitialized &&
			selectionSignature === renderedSelectionSignature &&
			history.length === renderedGhostHistoryLength &&
			renderedShowLegend === showLegend &&
			currentTimeLength > renderedTimeLength;

		if (canExtend) {
			extendScopeTraces(scope, currentTimeLength);
			return;
		}

		fullScopeRender(scope, history, selectionSignature, currentTimeLength);
	}

	function fullScopeRender(
		scope: ScopeSeries,
		history: ScopeSeries[],
		selectionSignature: string,
		currentTimeLength: number
	): void {
		if (!Plotly || !plotDiv) return;

		const traces = buildPlotTraces(scope, history);
		const layout = buildPlotLayout();

		Plotly.react(plotDiv, traces, layout, PLOTLY_CONFIG);

		if (isStreaming && currentTimeLength > 0) {
			streamingInitialized = true;
			renderedTimeLength = currentTimeLength;
			renderedSelectionSignature = selectionSignature;
			renderedGhostHistoryLength = history.length;
			renderedShowLegend = showLegend;
			return;
		}

		streamingInitialized = false;
		renderedTimeLength = currentTimeLength;
		renderedSelectionSignature = selectionSignature;
		renderedGhostHistoryLength = history.length;
		renderedShowLegend = showLegend;
	}

	function extendScopeTraces(scope: ScopeSeries, currentTimeLength: number): void {
		if (!Plotly || !plotDiv) return;

		const newStartIndex = renderedTimeLength;
		const xData: number[][] = [];
		const yData: number[][] = [];
		const traceIndices: number[] = [];

		selectedLeaves.forEach((leaf, index) => {
			xData.push(scope.time.slice(newStartIndex));
			yData.push((scope.signals[leaf.index] ?? []).slice(newStartIndex));
			traceIndices.push(ghostTraceCount + index);
		});

		if (xData.length > 0 && xData[0].length > 0) {
			Plotly.extendTraces(plotDiv, { x: xData, y: yData }, traceIndices);
		}

		renderedTimeLength = currentTimeLength;
	}

	function renderPlot(): void {
		if (!Plotly || !plotDiv) return;

		const scope = acausalScope;
		const baseLayout = getBaseLayout();
		const layout = buildPlotLayout();

		if (!scope) {
			const emptyLayout = createEmptyLayout(layout);
			emptyLayout.annotations = [{
				text: 'Run simulation to browse acausal results',
				xref: 'paper',
				yref: 'paper',
				x: 0.5,
				y: 0.5,
				showarrow: false,
				font: { size: 14, color: baseLayout.font?.color }
			}];
			Plotly.react(plotDiv, [], emptyLayout, PLOTLY_CONFIG);
			resetPlotRenderState();
			return;
		}

		if (selectedLeaves.length === 0) {
			const emptyLayout = createEmptyLayout(layout);
			emptyLayout.annotations = [{
				text: 'Select one or more signals to plot',
				xref: 'paper',
				yref: 'paper',
				x: 0.5,
				y: 0.5,
				showarrow: false,
				font: { size: 14, color: baseLayout.font?.color }
			}];
			Plotly.react(plotDiv, [], emptyLayout, PLOTLY_CONFIG);
			resetPlotRenderState();
			return;
		}

		renderScopePlot(scope);
	}
</script>

<div class="acausal-results-panel">
	<div class="signal-browser">
		<div class="browser-toolbar">
			<div class="browser-summary">
				<Icon name="layers" size={14} />
				<span>{signalLeaves.length} signals</span>
			</div>
			<div class="browser-actions">
				<button class="mini-btn" onclick={selectAllSignals}>All</button>
				<button class="mini-btn" onclick={clearSignals}>Clear</button>
			</div>
		</div>

		<div class="tree-list">
			{#if treeRows.length === 0}
				<div class="empty-tree">Run simulation to populate acausal results.</div>
			{:else}
				{#each treeRows as row (row.kind === 'group' ? row.key : row.leaf.key)}
					{#if row.kind === 'group'}
						<button
							class="tree-row group-row"
							style={`padding-left: ${8 + row.depth * 18}px;`}
							onclick={() => toggleGroup(row.key)}
						>
							<Icon name={expandedGroups.has(row.key) ? 'chevron-down' : 'chevron-right'} size={12} />
							<Icon name="folder" size={12} />
							<span>{row.label}</span>
						</button>
					{:else}
						<label
							class="tree-row leaf-row"
							style={`padding-left: ${14 + row.depth * 18}px;`}
						>
							<input
								type="checkbox"
								checked={selectedSignals.has(row.leaf.key)}
								onchange={() => toggleSignal(row.leaf.key)}
							/>
							<Icon name="activity" size={12} />
							<span class="leaf-label">{row.leaf.shortLabel}</span>
							{#if row.leaf.shortLabel !== row.leaf.label}
								<span class="leaf-path" title={row.leaf.label}>{row.leaf.label}</span>
							{/if}
						</label>
					{/if}
				{/each}
			{/if}
		</div>
	</div>

	<div class="plot-panel">
		<div class="plot-header">
			<div class="plot-title">Selected signals</div>
			<div class="plot-header-right">
				<div class="plot-meta">{selectedLeaves.length} shown</div>
				<button
					class="mini-btn"
					class:active={showLegend}
					onclick={toggleLegend}
					title={showLegend ? 'Hide legend' : 'Show legend'}
					aria-label={showLegend ? 'Hide legend' : 'Show legend'}
				>
					Legend
				</button>
			</div>
		</div>
		<div class="plot-container">
			<div class="plot" bind:this={plotDiv}></div>
		</div>
	</div>
</div>

<style>
	.acausal-results-panel {
		display: grid;
		grid-template-columns: minmax(240px, 300px) minmax(0, 1fr);
		height: 100%;
		min-height: 0;
		overflow: hidden;
		background: var(--surface);
	}

	.signal-browser {
		display: flex;
		flex-direction: column;
		min-width: 0;
		min-height: 0;
		overflow: hidden;
		border-right: 1px solid var(--border);
		background: color-mix(in srgb, var(--surface-raised) 55%, var(--surface));
	}

	.browser-toolbar {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: var(--space-sm);
		border-bottom: 1px solid var(--border);
		gap: var(--space-sm);
	}

	.browser-summary {
		display: flex;
		align-items: center;
		gap: 6px;
		font-size: 12px;
		color: var(--text-muted);
	}

	.browser-actions {
		display: flex;
		gap: 6px;
	}

	.mini-btn {
		height: 24px;
		padding: 0 8px;
		font-size: 11px;
		border-radius: 8px;
		border: 1px solid var(--border);
		background: var(--surface);
		color: var(--text-muted);
		cursor: pointer;
	}

	.mini-btn:hover {
		background: var(--surface-hover);
		border-color: var(--border-focus);
		color: var(--text);
	}

	.tree-list {
		flex: 1;
		min-height: 0;
		overflow: auto;
		padding: var(--space-xs) 0;
	}

	.tree-row {
		display: flex;
		align-items: center;
		justify-content: flex-start;
		gap: 6px;
		min-height: 28px;
		width: 100%;
		padding-right: var(--space-sm);
		font-size: 12px;
		color: var(--text);
	}

	.group-row {
		border: none;
		background: transparent;
		cursor: pointer;
		text-align: left;
		color: var(--text-muted);
	}

	.group-row:hover,
	.leaf-row:hover {
		background: var(--surface-hover);
	}

	.leaf-row {
		cursor: pointer;
	}

	.leaf-row input {
		margin: 0;
	}

	.leaf-label {
		font-weight: 500;
	}

	.leaf-path {
		margin-left: auto;
		color: var(--text-disabled);
		font-size: 10px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.empty-tree {
		padding: var(--space-md);
		font-size: 12px;
		color: var(--text-disabled);
	}

	.plot-panel {
		display: flex;
		flex-direction: column;
		min-width: 0;
		min-height: 0;
	}

	.plot-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: var(--space-sm) var(--space-md);
		border-bottom: 1px solid var(--border);
	}

	.plot-header-right {
		display: flex;
		align-items: center;
		gap: var(--space-sm);
	}

	.plot-title {
		font-size: 12px;
		font-weight: 600;
		color: var(--text);
	}

	.plot-meta {
		font-size: 11px;
		color: var(--text-muted);
	}

	.mini-btn.active {
		background: color-mix(in srgb, var(--accent) 14%, var(--surface));
		border-color: color-mix(in srgb, var(--accent) 45%, var(--border));
		color: var(--text);
	}

	.mini-btn.active:hover {
		background: color-mix(in srgb, var(--accent) 18%, var(--surface-hover));
		border-color: color-mix(in srgb, var(--accent) 55%, var(--border-focus));
	}

	.plot-container {
		flex: 1;
		min-height: 0;
		overflow: hidden;
	}

	.plot {
		width: 100%;
		height: 100%;
		min-height: 180px;
	}
 </style>
