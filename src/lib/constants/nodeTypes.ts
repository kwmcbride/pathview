/**
 * Centralized node type identifiers
 * Subsystem and Interface match the PathSim block class names directly.
 * Bus Creator and Bus Selector exist only in the editor and are resolved before code generation.
 */
export const NODE_TYPES = {
	SUBSYSTEM: 'Subsystem',
	INTERFACE: 'Interface',
	BUS_CREATOR: 'BusCreator',
	BUS_SELECTOR: 'BusSelector'
} as const;

export type NodeTypeId = (typeof NODE_TYPES)[keyof typeof NODE_TYPES];

/** Library category of the editor-only bus blocks */
export const BUS_CATEGORY = 'Buses';
