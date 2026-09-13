<script lang="ts">
	import { INLINE_INPUT } from '$lib/constants/dimensions';

	interface Props {
		value?: string;
		placeholder?: string;
		/** Names offered below the input; omit for a plain text field */
		suggestions?: string[];
		/** Text of the entry that commits a name missing from the suggestions; omit to hide it */
		createLabel?: (text: string) => string;
		onCommit: (text: string) => void;
		onCancel: () => void;
	}

	let { value = '', placeholder = '', suggestions, createLabel, onCommit, onCancel }: Props = $props();

	interface Option {
		text: string;
		create: boolean;
		/** Index of the query inside the text, -1 for the create entry */
		match: number;
	}

	// svelte-ignore state_referenced_locally
	let text = $state(value);
	let activeIndex = $state(0);
	let listPosition = $state<{ x: number; y: number } | null>(null);
	let listEl = $state<HTMLElement | null>(null);

	const query = $derived(text.trim());

	// Matching suggestions, prefix matches first, then the create entry
	const options = $derived.by((): Option[] => {
		if (!suggestions) return [];
		const lower = query.toLowerCase();
		const matches = suggestions
			.map((name) => ({ text: name, create: false, match: name.toLowerCase().indexOf(lower) }))
			.filter((option) => option.match >= 0)
			.sort((a, b) => a.match - b.match)
			.slice(0, INLINE_INPUT.maxSuggestions);
		if (createLabel && query && !suggestions.includes(query)) {
			matches.push({ text: query, create: true, match: -1 });
		}
		return matches;
	});

	const active = $derived(Math.min(activeIndex, options.length - 1));

	function commitActive() {
		onCommit(active >= 0 ? options[active].text : text);
	}

	function pick(event: PointerEvent, option: Option) {
		event.preventDefault();
		event.stopPropagation();
		onCommit(option.text);
	}

	/**
	 * Enter commits, Escape cancels, a pointer press outside commits the typed
	 * text. Blur alone never commits, because removing the editor also blurs
	 * the input. Keys stop at the input so canvas shortcuts never see them.
	 * Focus waits a frame, the caller may still move the input into a portal.
	 * While suggestions are shown, the list follows the input on screen.
	 */
	function inlineInput(input: HTMLInputElement) {
		const onKeydown = (event: KeyboardEvent) => {
			event.stopPropagation();
			const count = options.length;
			if (event.key === 'Enter') commitActive();
			else if (event.key === 'Escape') onCancel();
			else if (event.key === 'ArrowDown' && count > 0) {
				event.preventDefault();
				activeIndex = (active + 1) % count;
			} else if (event.key === 'ArrowUp' && count > 0) {
				event.preventDefault();
				activeIndex = (active - 1 + count) % count;
			} else if (event.key === 'Tab' && active >= 0) {
				event.preventDefault();
				text = options[active].text;
			}
		};
		const onInput = () => {
			activeIndex = 0;
		};
		const onPointerDown = (event: PointerEvent) => {
			const target = event.target as Node;
			if (target !== input && !listEl?.contains(target)) onCommit(text);
		};

		let frame = 0;
		const follow = () => {
			const rect = input.getBoundingClientRect();
			const x = rect.left + rect.width / 2;
			const y = rect.bottom + INLINE_INPUT.listGap;
			if (listPosition?.x !== x || listPosition?.y !== y) listPosition = { x, y };
			frame = requestAnimationFrame(follow);
		};

		input.addEventListener('keydown', onKeydown);
		input.addEventListener('input', onInput);
		document.addEventListener('pointerdown', onPointerDown, true);
		requestAnimationFrame(() => {
			input.focus();
			input.select();
			if (suggestions) follow();
		});
		return {
			destroy: () => {
				cancelAnimationFrame(frame);
				input.removeEventListener('keydown', onKeydown);
				input.removeEventListener('input', onInput);
				document.removeEventListener('pointerdown', onPointerDown, true);
			}
		};
	}

	/** Render at the document root, so the list keeps screen size and is never clipped by the canvas */
	function portal(node: HTMLElement) {
		document.body.appendChild(node);
		return { destroy: () => node.remove() };
	}
</script>

<input
	class="inline-input"
	style="--input-height: {INLINE_INPUT.height}px; --input-padding-x: {INLINE_INPUT.paddingX}px; --input-chars: {Math.max(text.length, INLINE_INPUT.minChars)};"
	bind:value={text}
	{placeholder}
	use:inlineInput
/>

{#if options.length > 0 && listPosition}
	<div
		bind:this={listEl}
		class="inline-input-list"
		style="left: {listPosition.x}px; top: {listPosition.y}px;"
		role="listbox"
		use:portal
	>
		{#each options as option, i (option.create ? '' : option.text)}
			<div
				class="option"
				class:active={i === active}
				class:create={option.create}
				role="option"
				aria-selected={i === active}
				tabindex="-1"
				onpointerdown={(event) => pick(event, option)}
				onpointerenter={() => (activeIndex = i)}
			>
				{#if option.create && createLabel}
					{createLabel(option.text)}
				{:else if query}
					{option.text.slice(0, option.match)}<span class="hit"
						>{option.text.slice(option.match, option.match + query.length)}</span
					>{option.text.slice(option.match + query.length)}
				{:else}
					{option.text}
				{/if}
			</div>
		{/each}
	</div>
{/if}

<style>
	/* Capsule on the canvas, styled like an active waypoint */
	.inline-input {
		box-sizing: border-box;
		height: var(--input-height);
		width: calc(var(--input-chars) * 1ch + 2 * var(--input-padding-x));
		padding: 0 var(--input-padding-x);
		border: 1.5px solid var(--accent);
		border-radius: calc(var(--input-height) / 2);
		background: var(--surface);
		color: var(--text);
		font-family: var(--font-ui);
		font-size: var(--font-xs);
		text-align: center;
		outline: none;
	}

	.inline-input::placeholder {
		color: var(--text-muted);
	}

	/* Suggestion list in screen space, styled like the context menu */
	.inline-input-list {
		position: fixed;
		z-index: var(--z-dropdown);
		transform: translateX(-50%);
		min-width: 100px;
		padding: 2px;
		display: flex;
		flex-direction: column;
		gap: 1px;
		background: var(--surface);
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		box-shadow: var(--shadow-md);
	}

	.option {
		padding: 3px 8px;
		border-radius: 4px;
		font-family: var(--font-ui);
		font-size: var(--font-base);
		color: var(--text-muted);
		white-space: nowrap;
		cursor: pointer;
	}

	.option.active {
		background: var(--accent-bg);
	}

	.hit {
		color: var(--text);
		font-weight: 500;
	}

	.option.create {
		color: var(--text-disabled);
	}

	.option.create.active {
		color: var(--text-muted);
	}
</style>
