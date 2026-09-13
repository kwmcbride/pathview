import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vitest/config';

export default defineConfig({
	plugins: [sveltekit()],
	optimizeDeps: {
		exclude: ['pyodide']
	},
	worker: {
		format: 'es'
	},
	test: {
		include: ['src/**/*.test.ts'],
		environment: 'node'
	}
});
