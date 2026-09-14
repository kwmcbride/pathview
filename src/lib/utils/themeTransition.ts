/**
 * Theme toggle with a radial "circle wipe" View Transition expanding from
 * the click position (or the center of a fallback element, e.g. when
 * triggered via keyboard shortcut). Falls back to a plain toggle when the
 * View Transitions API is unavailable.
 */

import { themeStore } from '$lib/stores/theme';

export function toggleThemeWithTransition(e?: MouseEvent, fallbackOrigin?: HTMLElement): void {
	const apply = () => themeStore.toggle();

	if (!document.startViewTransition) {
		apply();
		return;
	}

	let x: number, y: number;
	if (e) {
		x = e.clientX;
		y = e.clientY;
	} else if (fallbackOrigin) {
		const rect = fallbackOrigin.getBoundingClientRect();
		x = rect.left + rect.width / 2;
		y = rect.top + rect.height / 2;
	} else {
		apply();
		return;
	}

	// The circle is given in percent of the snapshot box, not in pixels: browsers may size the
	// snapshot in device pixels (e.g. on high-density displays with GPU rendering), which would
	// put a pixel-based center at the wrong place. Percent radii refer to the box diagonal / sqrt(2).
	const maxRadius = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));
	const center = `${(x / innerWidth) * 100}% ${(y / innerHeight) * 100}%`;
	const radius = (maxRadius / (Math.hypot(innerWidth, innerHeight) / Math.SQRT2)) * 100;
	const transition = document.startViewTransition(apply);
	transition.ready.then(() => {
		document.documentElement.animate(
			{ clipPath: [`circle(0% at ${center})`, `circle(${radius}% at ${center})`] },
			{ duration: 500, easing: 'ease-out', pseudoElement: '::view-transition-new(root)' }
		);
	});
}
