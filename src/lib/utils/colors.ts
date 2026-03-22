/**
 * Color definitions for PathView
 */

// Default node/event color (matches --pathsim-blue CSS variable)
export const DEFAULT_NODE_COLOR = '#0070C0';

// Port colors
export const PORT_COLORS = {
	default: '#969696', // Gray: rgb(150, 150, 150)
	signal: '#64c8ff', // Blue: rgb(100, 200, 255)
	control: '#ffc864', // Orange: rgb(255, 200, 100)
	data: '#c864ff' // Purple: rgb(200, 100, 255)
};

// Acausal domain colors (port handles and edge lines)
export const ACAUSAL_DOMAIN_COLORS: Record<string, string> = {
	electrical: '#f5a623', // Amber — voltage/current
	gas:        '#4ea8de', // Sky blue — pressure/mass flow
	gas_stream: '#38bdf8', // Light sky — stream gas
	mechanical: '#94a3b8', // Slate — force/velocity
	thermal:    '#f87171', // Red — temperature/heat flux
	hydraulic:  '#34d399', // Emerald — hydraulic pressure/flow
	default:    '#969696'  // Gray fallback
};

// Color palette for dialogs (block/event properties)
export const DIALOG_COLOR_PALETTE = [
	DEFAULT_NODE_COLOR, // PathSim blue (default)
	'#E57373', // Red
	'#FFB74D', // Orange
	'#FFF176', // Yellow
	'#81C784', // Green
	'#4DB6AC', // Teal
	'#4DD0E1', // Cyan
	'#64B5F6', // Blue
	'#BA68C8', // Purple
	'#F06292', // Pink
	'#90A4AE', // Grey
	'#FFFFFF' // White
];
