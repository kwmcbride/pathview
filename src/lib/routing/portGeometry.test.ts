import { describe, it, expect } from 'vitest';
import { getPortInfo } from './portGeometry';

const center = { x: 100, y: 100 };

describe('getPortInfo', () => {
	it('places outputs on the right and inputs on the left without rotation', () => {
		expect(getPortInfo(center, 80, 40, 0, 0, 2, true)).toEqual({ position: { x: 145, y: 90 }, direction: 'right' });
		expect(getPortInfo(center, 80, 40, 0, 1, 2, false)).toEqual({ position: { x: 52.5, y: 110 }, direction: 'left' });
	});

	it('follows the rotation', () => {
		expect(getPortInfo(center, 40, 80, 1, 0, 2, true)).toEqual({ position: { x: 90, y: 145 }, direction: 'down' });
		expect(getPortInfo(center, 40, 80, 1, 0, 1, false)).toEqual({ position: { x: 100, y: 52.5 }, direction: 'up' });
		expect(getPortInfo(center, 80, 40, 2, 0, 1, false)).toEqual({ position: { x: 147.5, y: 100 }, direction: 'right' });
		expect(getPortInfo(center, 40, 80, 3, 2, 3, true)).toEqual({ position: { x: 120, y: 55 }, direction: 'up' });
	});
});
