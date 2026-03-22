import { get, writable } from 'svelte/store';

export type BranchSegmentOrientation = 'horizontal' | 'vertical';

export interface BranchDragState {
	active: boolean;
	suppressContextMenu: boolean;
	mode: 'edge' | 'junction' | null;
	edgeId: string | null;
	junctionNodeId: string | null;
	domain: string | null;
	domainColor?: string;
	junctionType: string | null;
	sourceNodeId: string | null;
	sourcePortIndex: number | null;
	targetNodeId: string | null;
	targetPortIndex: number | null;
	junctionFlowPosition: { x: number; y: number } | null;
	junctionScreenPosition: { x: number; y: number } | null;
	currentScreenPosition: { x: number; y: number } | null;
	sourceJunctionPort: number | null;
	targetJunctionPort: number | null;
	segmentOrientation: BranchSegmentOrientation | null;
}

const initialState: BranchDragState = {
	active: false,
	suppressContextMenu: false,
	mode: null,
	edgeId: null,
	junctionNodeId: null,
	domain: null,
	domainColor: undefined,
	junctionType: null,
	sourceNodeId: null,
	sourcePortIndex: null,
	targetNodeId: null,
	targetPortIndex: null,
	junctionFlowPosition: null,
	junctionScreenPosition: null,
	currentScreenPosition: null,
	sourceJunctionPort: null,
	targetJunctionPort: null,
	segmentOrientation: null
};

const store = writable<BranchDragState>(initialState);

export const branchDragStore = {
	subscribe: store.subscribe,
	start(state: Omit<BranchDragState, 'active' | 'suppressContextMenu' | 'currentScreenPosition'>) {
		store.set({
			...initialState,
			...state,
			active: true,
			suppressContextMenu: true,
			currentScreenPosition: state.junctionScreenPosition
		});
	},
	updatePointer(position: { x: number; y: number }) {
		store.update((state) => (state.active ? { ...state, currentScreenPosition: position } : state));
	},
	cancel() {
		store.update((state) => ({
			...initialState,
			suppressContextMenu: state.suppressContextMenu
		}));
	},
	suppressContextMenu() {
		store.update((state) => ({ ...state, suppressContextMenu: true }));
	},
	clearContextMenuSuppression() {
		store.update((state) => ({ ...state, suppressContextMenu: false }));
	},
	get(): BranchDragState {
		return get(store);
	}
};
