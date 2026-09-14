/**
 * Inline edit state - the canvas text currently edited inline with the pill
 * editor: a connection label (by connection ID) or a bus block signal name
 * (by "<node>:<direction>:<index>"). One at a time.
 */

export const inlineEdit = $state<{ targetId: string | null }>({ targetId: null });

/** Start editing a text inline, or stop editing with null */
export function editInline(targetId: string | null): void {
	inlineEdit.targetId = targetId;
}
