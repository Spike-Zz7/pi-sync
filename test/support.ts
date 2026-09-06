export interface MockNotification {
	message: string;
	level: "info" | "warning" | "error";
}

export function createMockPi() {
	const commands = new Map<string, any>();
	const events = new Map<string, Array<(...args: any[]) => any>>();
	const pi = {
		registerCommand(name: string, def: any) {
			commands.set(name, def);
		},
		on(event: string, handler: (...args: any[]) => any) {
			const list = events.get(event) ?? [];
			list.push(handler);
			events.set(event, list);
		},
	};
	return { pi, commands, events };
}

export function createMockContext(options: any = {}) {
	const notifications: MockNotification[] = [];
	const statuses = new Map<string, string>();
	const widgets = new Map<string, any>();
	const ctx = {
		hasUI: options.hasUI ?? true,
		mode: options.mode ?? "tui",
		cwd: options.cwd ?? process.cwd(),
		ui: {
			theme: options.theme ?? {
				fg: (_color: string, text: string) => text,
				bold: (text: string) => text,
			},
			notify: (
				message: string,
				level: "info" | "warning" | "error" = "info",
			) => {
				notifications.push({ message, level });
			},
			confirm: options.confirm ?? (async () => true),
			select: options.select ?? (async () => undefined),
			input: options.input ?? (async () => undefined),
			custom:
				options.custom ??
				(async (factory: any) => {
					let doneVal: any;
					const done = (val: any) => {
						doneVal = val;
					};
					const tui = {
						terminal: { columns: 100, rows: 24 },
						requestRender: () => {},
					};
					const theme = {
						fg: (_color: string, text: string) => text,
						bold: (text: string) => text,
					};
					const keybindings = {
						getKeys: () => [],
						matches: (data: string, action: string) => data === action,
					};
					const comp = factory(tui, theme, keybindings, done);
					if (
						comp &&
						typeof comp.render === "function" &&
						typeof options.select === "function"
					) {
						const lines: string[] = comp.render(100);
						const clean = lines.filter(
							(l) =>
								!l.startsWith("─") &&
								!l.includes("ctrl+c") &&
								!l.includes("esc "),
						);
						const firstOptionIdx = clean.findIndex(
							(l) => l.startsWith("→ ") || l.startsWith("› "),
						);
						let title: string;
						const rows: string[] = [];
						if (firstOptionIdx === -1) {
							title = clean.join("\n").trim();
						} else {
							title = clean.slice(0, firstOptionIdx).join("\n").trim();
							for (const line of clean.slice(firstOptionIdx)) {
								const m = line.match(
									/^[›→\s]\s*(?:\[[ x-]\]\s+)?([^\s].*?)(?:\s+\([0-9]+\/[0-9]+\))?$/u,
								);
								if (m) rows.push(m[1].trim());
							}
						}
						const choice = await options.select(title, rows);
						if (choice !== undefined) {
							const idx = rows.findIndex(
								(r) => r === choice || r.startsWith(choice),
							);
							if (idx >= 0) {
								for (let k = 0; k < idx; k++)
									comp.handleInput("tui.select.down");
								comp.handleInput("tui.select.confirm");
							} else {
								comp.handleInput("tui.select.cancel");
							}
						} else {
							comp.handleInput("tui.select.cancel");
						}
						await comp.waitForPending?.();
					}
					return doneVal;
				}),
			setStatus: (key: string, text?: string) => {
				if (text === undefined) statuses.delete(key);
				else statuses.set(key, text);
			},
			setWidget: (key: string, widget?: any) => {
				if (widget === undefined) widgets.delete(key);
				else widgets.set(key, widget);
			},
		},
	};
	return { ctx, notifications, statuses, widgets };
}

export function createCustomSelectorHarness(factory: any, defaultWidth = 100) {
	let doneCalled = false;
	let doneValue: any;
	let resolveResult: (val: any) => void;
	const resultPromise = new Promise((resolve) => {
		resolveResult = resolve;
	});

	const done = (value: any) => {
		doneCalled = true;
		doneValue = value;
		resolveResult(value);
	};

	const tui = {
		terminal: {
			columns: defaultWidth,
			rows: 24,
		},
		requestRender: () => {},
	};

	const theme = {
		fg: (_color: string, text: string) => text,
		bold: (text: string) => text,
	};

	const keybindings = {
		getKeys: () => [],
		matches: (data: string, action: string) => {
			if (data === action) return true;
			if (
				action === "tui.select.down" &&
				(data === "down" || data === "\u001b[B" || data === "j")
			)
				return true;
			if (
				action === "tui.select.up" &&
				(data === "up" || data === "\u001b[A" || data === "k")
			)
				return true;
			if (
				action === "tui.select.confirm" &&
				(data === "\r" || data === "\n" || data === "enter")
			)
				return true;
			if (
				action === "tui.select.cancel" &&
				(data === "\u001b" || data === "escape" || data === "\u0003")
			)
				return true;
			if (
				action === "tui.editor.deleteCharBackward" &&
				(data === "\x7f" || data === "\b")
			)
				return true;
			return false;
		},
	};

	const component = factory(tui, theme, keybindings, done);

	return {
		get result() {
			return doneCalled ? Promise.resolve(doneValue) : resultPromise;
		},
		render(width = defaultWidth) {
			return component.render(width);
		},
		handleInput(data: string) {
			component.handleInput(data);
		},
		async waitForPending() {
			await new Promise((resolve) => setImmediate(resolve));
			await new Promise((resolve) => setTimeout(resolve, 15));
		},
		dispose() {
			component.dispose?.();
			if (!doneCalled) {
				done(undefined);
			}
		},
	};
}
