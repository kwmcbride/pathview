/**
 * Routing worker - hosts the routing engine off the main thread
 */

import { RoutingEngine } from './engine';
import { applyDelta, type RoutingDelta } from './protocol';

let engine = new RoutingEngine();

onmessage = (event: MessageEvent<RoutingDelta>) => {
	if (event.data.reset) engine = new RoutingEngine();
	postMessage(applyDelta(engine, event.data));
};
