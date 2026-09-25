import { execFile } from "node:child_process";

export type SecretReader = (command: string[]) => Promise<string>;

export const commandSecretReader: SecretReader = (command) =>
	new Promise((resolve, reject) => {
		execFile(command[0], command.slice(1), { encoding: "utf8", timeout: 15_000 }, (error, stdout) => {
			if (error) {
				reject(new Error(`secret command ${command[0]} failed`));
				return;
			}
			const secret = stdout.split(/\r?\n/)[0]?.trim();
			if (!secret) {
				reject(new Error(`secret command ${command[0]} returned nothing`));
				return;
			}
			resolve(secret);
		});
	});

export function redact(text: string, secrets: readonly string[]): string {
	let out = text;
	for (const secret of secrets) if (secret && secret.length >= 4) out = out.split(secret).join("[redacted]");
	return out;
}

export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
