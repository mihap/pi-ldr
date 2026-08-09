import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Key, Markdown, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import {
	currentSpec,
	deinitProject,
	findGitRoot,
	initProject,
	LdrError,
	newWork,
	type GitExec,
} from "./core.ts";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const LDR_TEMPLATE_PATH = resolve(PACKAGE_ROOT, "templates/LDR.md");

function messageFor(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function report(ctx: ExtensionCommandContext, message: string, type: "info" | "warning" | "error" = "info"): void {
	const output = message.endsWith("\n") ? message : `${message}\n`;
	if (ctx.mode === "json") {
		process.stderr.write(output);
		return;
	}
	if (ctx.hasUI) {
		ctx.ui.notify(message, type);
		return;
	}
	if (type === "error") process.stderr.write(output);
	else process.stdout.write(output);
}

function gitExecutor(pi: ExtensionAPI): GitExec {
	return async (args, cwd) => pi.exec("git", args, { cwd });
}

function formatInitResult(changes: Array<{ path: string; kind: string }>): string {
	return [
		"LDR project integration reconciled. No commit was created.",
		"",
		...changes.map(({ path, kind }) => `- ${kind}: ${path}`),
	].join("\n");
}

async function showSpec(ctx: ExtensionCommandContext, path: string, content: string): Promise<void> {
	if (ctx.mode === "rpc") {
		await ctx.ui.editor(`Current LDR: ${path}`, content);
		return;
	}
	if (ctx.mode !== "tui") {
		report(ctx, `${path}\n\n${content}`);
		return;
	}

	await ctx.ui.custom<void>((tui, theme, keybindings, done) => {
		const markdown = new Markdown(content, 1, 0, getMarkdownTheme());
		let offset = 0;
		let pageSize = 1;
		let totalLines = 0;

		const clampOffset = () => {
			offset = Math.max(0, Math.min(offset, Math.max(0, totalLines - pageSize)));
		};

		return {
			render(width: number): string[] {
				const safeWidth = Math.max(1, width);
				const lines = markdown.render(safeWidth);
				totalLines = lines.length;
				pageSize = Math.max(3, Math.min(Math.max(3, tui.terminal.rows - 6), Math.max(3, totalLines)));
				clampOffset();

				const border = theme.fg("borderAccent", "─".repeat(safeWidth));
				const title = truncateToWidth(theme.fg("accent", theme.bold(`Current LDR · ${path}`)), safeWidth);
				const visible = lines.slice(offset, offset + pageSize);
				const position = totalLines === 0 ? "empty" : `${offset + 1}–${Math.min(offset + pageSize, totalLines)} of ${totalLines}`;
				const status = truncateToWidth(theme.fg("dim", `${position} · ↑↓/PgUp/PgDn scroll · q/esc close`), safeWidth);
				return [border, title, ...visible, status, border];
			},
			handleInput(data: string): void {
				if (keybindings.matches(data, "tui.select.cancel") || matchesKey(data, Key.escape) || data === "q") {
					done();
					return;
				}
				if (matchesKey(data, Key.up) || data === "k") offset -= 1;
				else if (matchesKey(data, Key.down) || data === "j") offset += 1;
				else if (matchesKey(data, Key.pageUp)) offset -= pageSize;
				else if (matchesKey(data, Key.pageDown)) offset += pageSize;
				else if (matchesKey(data, Key.home)) offset = 0;
				else if (matchesKey(data, Key.end)) offset = Math.max(0, totalLines - pageSize);
				clampOffset();
				tui.requestRender();
			},
			invalidate(): void {
				markdown.invalidate();
			},
		};
	});
}

export default function ldrExtension(pi: ExtensionAPI) {
	const exec = gitExecutor(pi);

	pi.registerCommand("ldr", {
		description: "Manage Linked Decision Records: init, new, view, deinit",
		getArgumentCompletions: (prefix) => {
			const commands = ["init", "new", "view", "deinit"];
			const normalized = prefix.trimStart();
			if (normalized.includes(" ")) return null;
			const matches = commands
				.filter((command) => command.startsWith(normalized))
				.map((command) => ({ value: command, label: command }));
			return matches.length ? matches : null;
		},
		handler: async (args, ctx) => {
			const input = args.trim();
			const firstSpace = input.indexOf(" ");
			const subcommand = firstSpace === -1 ? input : input.slice(0, firstSpace);
			const rest = firstSpace === -1 ? "" : input.slice(firstSpace + 1).trim();

			try {
				const root = await findGitRoot(exec, ctx.cwd);
				switch (subcommand) {
					case "init": {
						if (rest) throw new LdrError("Usage: /ldr init");
						const template = await readFile(LDR_TEMPLATE_PATH, "utf8");
						const result = await initProject(root, template);
						report(ctx, formatInitResult(result.changes));
						return;
					}
					case "new": {
						const result = await newWork(root, rest, exec);
						report(
							ctx,
							[
								`Started LDR work ${result.slug}. No commit was created.`,
								"",
								`- switched to: ${result.branch}`,
								`- created: ${result.specPath}`,
								"- next: complete and review the Brief before adding the Spec",
							].join("\n"),
						);
						return;
					}
					case "view": {
						if (rest) throw new LdrError("Usage: /ldr view");
						const spec = await currentSpec(root, exec);
						await showSpec(ctx, spec.path, spec.content);
						return;
					}
					case "deinit": {
						if (rest) throw new LdrError("Usage: /ldr deinit");
						if (!ctx.hasUI) throw new LdrError("/ldr deinit requires an interactive confirmation dialog.");
						const choice = await ctx.ui.select(
							[
								"Remove LDR project integration?",
								"",
								"Will remove:",
								"- LDR.md generated by pi-ldr",
								"- Managed LDR section from AGENTS.md",
								"- docs/specs directory, only if empty",
								"",
								"Will preserve:",
								"- Existing decision records",
								"- Non-LDR AGENTS.md content",
								"- Git branches",
								"- Current working changes",
							].join("\n"),
							["Remove integration", "Cancel"],
						);
						if (choice !== "Remove integration") {
							report(ctx, "LDR deinitialization cancelled.");
							return;
						}
						const result = await deinitProject(root);
						const lines = ["LDR project integration removed. No commit was created."];
						if (result.removed.length) lines.push("", "Removed:", ...result.removed.map((path) => `- ${path}`));
						if (result.preserved.length) lines.push("", "Preserved:", ...result.preserved.map((path) => `- ${path}`));
						report(ctx, lines.join("\n"));
						return;
					}
					default:
						throw new LdrError("Usage: /ldr <init | new <name> | view | deinit>");
				}
			} catch (error) {
				report(ctx, messageFor(error), "error");
			}
		},
	});
}
