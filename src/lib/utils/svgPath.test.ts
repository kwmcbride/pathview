import { describe, expect, it } from 'vitest';
import { roundedPolygonPath } from './svgPath';

describe('roundedPolygonPath', () => {
	it('rounds every corner of a closed polygon', () => {
		expect(roundedPolygonPath([[0, 0], [10, 0], [10, 10], [0, 10]], 2)).toBe(
			'M 0 2 Q 0 0 2 0 L 8 0 Q 10 0 10 2 L 10 8 Q 10 10 8 10 L 2 10 Q 0 10 0 8 Z'
		);
	});

	it('clamps the radius to half of the shorter side', () => {
		expect(roundedPolygonPath([[0, 0], [2, 0], [2, 10], [0, 10]], 5)).toBe(
			'M 0 1 Q 0 0 1 0 L 1 0 Q 2 0 2 1 L 2 9 Q 2 10 1 10 L 1 10 Q 0 10 0 9 Z'
		);
	});
});
