#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { runCli } from "../src/work/cli.ts";
import type { Runtime } from "../src/work/runtime.ts";
import { openRuntime } from "../src/work/runtime.ts";

let runtime: Runtime | undefined;
const io = {
	out: (text: string) => void process.stdout.write(`${text}\n`),
	err: (text: string) => void process.stderr.write(`${text}\n`),
	ask: async (question: string) => {
		const rl = createInterface({ input: process.stdin, output: process.stdout });
		try {
			return await rl.question(question);
		} finally {
			rl.close();
		}
	},
};

const code = await runCli(process.argv.slice(2), {
	runtime: () => (runtime ??= openRuntime()),
	io,
	cwd: process.cwd(),
	env: process.env,
});
runtime?.store.close();
process.exitCode = code;
