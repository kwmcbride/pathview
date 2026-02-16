/**
 * Mask registry
 */

import type { NodeMask } from './types';
import { constantMask } from './templates/constant.mask';
import { powMask } from './templates/pow.mask';

const masks = new Map<string, NodeMask>();

export function registerMask(mask: NodeMask): void {
	masks.set(mask.type, mask);
}

export function getMask(type: string): NodeMask | undefined {
	return masks.get(type);
}

// Register built-ins
registerMask(constantMask);
registerMask(powMask);
