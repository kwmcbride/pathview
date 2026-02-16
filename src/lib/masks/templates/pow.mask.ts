/**
 * Constant block mask (example)
 *
 * - True silhouette via clip-path
 * - SVG overlay with port label for output
 */

import type { NodeMask } from '../types';

// NOTE:
// `clip-path: path('...')` currently does NOT support CSS `calc()` reliably across browsers.
// Keep the path purely numeric and use percentages/polygon when you need responsive shapes.
//
// This is a simple 8-point "ticket" polygon, easy to edit:
// - notches on left/right
const TICKET_CLIP_PATH =
    "polygon(0% 12%, 12% 0%, 88% 0%, 100% 12%, 100% 88%, 88% 100%, 12% 100%, 0% 88%)";

export const powMask: NodeMask = {
    type: 'Pow',
    clipPath: TICKET_CLIP_PATH,
    contentPadding: '6px 10px',
    portLabels: 'svg',
    renderSvg: ({ width, height, node }) => {
        try {
            const out = node.outputs?.[0]?.name ?? 'out';
            const exponent = node.params?.exponent ?? 2;

            // Obvious debug overlay: diagonal stripes + translucent tint
            return `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" preserveAspectRatio="none">
    <defs>
        <pattern id="pv-constant-stripes" patternUnits="userSpaceOnUse" width="12" height="12" patternTransform="rotate(35)">
            <rect width="12" height="12" fill="transparent" />
            <rect x="0" y="0" width="6" height="12" fill="currentColor" opacity="0.18" />
        </pattern>
    </defs>

    <!-- base tint so it's clearly visible even on light/dark themes -->
    <rect x="0" y="0" width="${Math.max(0, width)}" height="${Math.max(0, height)}" fill="currentColor" opacity="0.06" />

    <!-- stripes -->
    
    <!-- big value text -->
    <text x="${width / 2}" y="${height / 2}" text-anchor="middle" dominant-baseline="central"
        font-family="system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif"
        font-size="${Math.max(12, Math.min(18, height * 0.45))}"
        font-weight="800"
        fill="currentColor"
        opacity="0.95">x
        <tspan baseline-shift="super" font-size="60%">${escapeXml(String(exponent))}</tspan>
        </text>

    <!-- output port label (right bottom) -->
    
</svg>`.trim();
        } catch (err) {
            // If anything goes wrong, return an obvious fallback so BaseNode doesn't show svg:null.
            console.error('constantMask.renderSvg failed', err);
            return `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" preserveAspectRatio="none">
    <rect x="0" y="0" width="${Math.max(0, width)}" height="${Math.max(0, height)}" fill="red" opacity="0.25" />
    <text x="${width / 2}" y="${height / 2}" text-anchor="middle" dominant-baseline="central"
        font-family="ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace"
        font-size="12" font-weight="800" fill="red">MASK ERROR</text>
</svg>`.trim();
        }
    }
};

function escapeXml(text: string): string {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}
