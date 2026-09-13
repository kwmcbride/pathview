/**
 * Edge label editing - which connection currently shows the inline label editor
 */

export const edgeLabelEdit = $state<{ connectionId: string | null }>({ connectionId: null });

/** Open the label editor for a connection, or close it with null */
export function editEdgeLabel(connectionId: string | null): void {
	edgeLabelEdit.connectionId = connectionId;
}
