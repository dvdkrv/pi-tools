export type Terminal = {
	columns(): number;
	rows(): number;
	write(data: string): void;
	onInput(handler: (data: string) => void): void;
	onResize(handler: () => void): void;
	start(): void;
	stop(): void;
};

export function frame(lines: readonly string[]): string {
	return `\x1b[H${lines.map((line) => `${line}\x1b[K`).join("\r\n")}\x1b[J`;
}

export function processTerminal(input: NodeJS.ReadStream = process.stdin, output: NodeJS.WriteStream = process.stdout): Terminal {
	let inputHandler: (data: string) => void = () => {};
	let resizeHandler: () => void = () => {};
	const onData = (chunk: Buffer | string): void => inputHandler(chunk.toString());
	const onResize = (): void => resizeHandler();
	return {
		columns: () => output.columns || 80,
		rows: () => output.rows || 24,
		write: (data) => {
			output.write(data);
		},
		onInput: (handler) => {
			inputHandler = handler;
		},
		onResize: (handler) => {
			resizeHandler = handler;
		},
		start() {
			if (!input.isTTY || !output.isTTY) throw new Error("work dash needs an interactive terminal");
			input.setRawMode(true);
			input.resume();
			input.on("data", onData);
			output.on("resize", onResize);
			output.write("\x1b[?1049h\x1b[?25l\x1b[H\x1b[2J");
		},
		stop() {
			input.off("data", onData);
			output.off("resize", onResize);
			output.write("\x1b[?25h\x1b[?1049l");
			if (input.isTTY) input.setRawMode(false);
			input.pause();
		},
	};
}
