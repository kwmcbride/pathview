/**
 * SVG path helpers
 */

/**
 * Path of a closed polygon with rounded corners. The radius is clamped to half
 * of the shorter side at each corner, so short sides never overlap.
 */
export function roundedPolygonPath(points: [number, number][], radius: number): string {
	const count = points.length;
	let d = '';
	for (let i = 0; i < count; i++) {
		const [px, py] = points[(i - 1 + count) % count];
		const [cx, cy] = points[i];
		const [nx, ny] = points[(i + 1) % count];
		const toPrev = Math.hypot(px - cx, py - cy);
		const toNext = Math.hypot(nx - cx, ny - cy);
		const r = Math.min(radius, toPrev / 2, toNext / 2);
		const startX = cx + ((px - cx) / toPrev) * r;
		const startY = cy + ((py - cy) / toPrev) * r;
		const endX = cx + ((nx - cx) / toNext) * r;
		const endY = cy + ((ny - cy) / toNext) * r;
		d += `${i === 0 ? 'M' : 'L'} ${startX} ${startY} Q ${cx} ${cy} ${endX} ${endY} `;
	}
	return `${d}Z`;
}
