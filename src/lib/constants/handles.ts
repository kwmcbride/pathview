/**
 * Handle and port naming constants
 * Centralizes the format strings used for port names and handle IDs
 */

/**
 * Port name generators
 */
export const PORT_NAME = {
	input: (index: number) => `in ${index}`,
	output: (index: number) => `out ${index}`
} as const;

// Pre-compiled regex patterns for handle ID parsing
const INPUT_INDEX_REGEX = /-input-(\d+)$/;
const OUTPUT_INDEX_REGEX = /-output-(\d+)$/;
const ACAUSAL_INDEX_REGEX = /-acausal-(\d+)$/;

/**
 * Handle ID generators and parsers
 * Handle format: "{nodeId}-{direction}-{index}" e.g., "node1-output-0"
 * Acausal handles: "{nodeId}-acausal-{index}" — rendered as source handles;
 * the matching target handle uses the standard input format.
 */
export const HANDLE_ID = {
	input: (nodeId: string, index: number) => `${nodeId}-input-${index}`,
	output: (nodeId: string, index: number) => `${nodeId}-output-${index}`,
	acausal: (nodeId: string, index: number) => `${nodeId}-acausal-${index}`,

	/**
	 * Parse handle ID to extract index
	 * @returns The port index, or null if not parseable
	 */
	parseIndex: (handleId: string, direction: 'input' | 'output' | 'acausal'): number | null => {
		const regex =
			direction === 'input' ? INPUT_INDEX_REGEX :
			direction === 'acausal' ? ACAUSAL_INDEX_REGEX :
			OUTPUT_INDEX_REGEX;
		const match = handleId.match(regex);
		return match ? parseInt(match[1], 10) : null;
	},

	/**
	 * Parse both source and target handles from a connection
	 * @returns Object with sourceIndex and targetIndex, or null values if not parseable
	 */
	parseConnection: (sourceHandle: string, targetHandle: string) => {
		return {
			sourceIndex: HANDLE_ID.parseIndex(sourceHandle, 'output'),
			targetIndex: HANDLE_ID.parseIndex(targetHandle, 'input')
		};
	},

	/**
	 * Parse an acausal connection (source: -acausal-N, target: -input-N)
	 * @returns Object with sourceIndex and targetIndex, or null values if not parseable
	 */
	parseAcausalConnection: (sourceHandle: string, targetHandle: string) => {
		return {
			sourceIndex: HANDLE_ID.parseIndex(sourceHandle, 'acausal'),
			targetIndex: HANDLE_ID.parseIndex(targetHandle, 'input')
		};
	}
} as const;
