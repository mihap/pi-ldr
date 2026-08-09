import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	AGENTS_END_MARKER,
	AGENTS_START_MARKER,
	briefScaffold,
	currentSpec,
	deinitProject,
	initProject,
	LDR_DOCUMENT_MARKER,
	MANAGED_AGENTS_SECTION,
	newWork,
	reconcileAgentsContent,
	removeManagedAgentsContent,
	slugifyWorkName,
	type GitExec,
} from "../extensions/ldr/core.ts";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
	const path = await mkdtemp(join(tmpdir(), "pi-ldr-test-"));
	temporaryDirectories.push(path);
	return path;
}

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const gitExec: GitExec = (args, cwd) =>
	new Promise((resolve, reject) => {
		const child = spawn("git", args, { cwd });
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => (stdout += chunk));
		child.stderr.on("data", (chunk) => (stderr += chunk));
		child.on("error", reject);
		child.on("close", (code) => resolve({ stdout, stderr, code: code ?? 1 }));
	});

async function mustGit(cwd: string, ...args: string[]): Promise<string> {
	const result = await gitExec(args, cwd);
	if (result.code !== 0) throw new Error(result.stderr || result.stdout);
	return result.stdout.trim();
}

const template = `${LDR_DOCUMENT_MARKER}\n# Linked Decision Records\n`;

describe("managed AGENTS.md section", () => {
	test("appends, reconciles, and removes only managed content", () => {
		const original = "# Project\n\nKeep this guidance.\n";
		const initialized = reconcileAgentsContent(original);
		expect(initialized.kind).toBe("updated");
		expect(initialized.content).toContain(MANAGED_AGENTS_SECTION);
		expect(reconcileAgentsContent(initialized.content)).toEqual({ content: initialized.content, kind: "unchanged" });
		expect(removeManagedAgentsContent(initialized.content)).toBe(original);
	});

	test("round-trips unrelated trailing whitespace exactly", () => {
		for (const original of ["Hard break  ", "Trailing blank lines\n\n", "Indented whitespace\n    "]) {
			const initialized = reconcileAgentsContent(original);
			expect(initialized.content).toBe(`${original}\n\n${MANAGED_AGENTS_SECTION}\n`);
			expect(removeManagedAgentsContent(initialized.content)).toBe(original);
		}
	});

	test("removes only owned separators around a managed section", () => {
		const before = "# Before\nMeaningful hard break  ";
		const after = "\n    indented continuation  \n\n";
		const content = `${before}\n\n${MANAGED_AGENTS_SECTION}\n${after}`;
		expect(removeManagedAgentsContent(content)).toBe(`${before}${after}`);
	});

	test("rejects malformed ownership markers", () => {
		expect(() => reconcileAgentsContent(`${AGENTS_START_MARKER}\nmissing end\n`)).toThrow("malformed pi-ldr markers");
		expect(() => removeManagedAgentsContent(`${AGENTS_END_MARKER}\n${AGENTS_START_MARKER}\n`)).toThrow(
			"end marker precedes",
		);
	});
});

describe("work naming", () => {
	test("creates concise kebab-case slugs", () => {
		expect(slugifyWorkName(" Add OAuth sign-in! ")).toBe("add-oauth-sign-in");
		expect(slugifyWorkName("Café's Search")).toBe("cafes-search");
	});

	test("creates a brief-only scaffold", () => {
		const scaffold = briefScaffold("OAuth login");
		expect(scaffold).toStartWith("# Work: OAuth Login\n\n## Brief");
		expect(scaffold).not.toContain("## Spec");
	});
});

describe("project lifecycle", () => {
	test("init is idempotent and preserves non-LDR AGENTS.md content", async () => {
		const root = await temporaryDirectory();
		await writeFile(join(root, "AGENTS.md"), "# Project rules\n");

		const first = await initProject(root, template);
		expect(first.changes).toEqual([
			{ path: "docs/specs/", kind: "created" },
			{ path: "LDR.md", kind: "created" },
			{ path: "AGENTS.md (managed LDR section)", kind: "updated" },
		]);
		const second = await initProject(root, template);
		expect(second.changes.every(({ kind }) => kind === "unchanged")).toBeTrue();
		expect(await readFile(join(root, "AGENTS.md"), "utf8")).toStartWith("# Project rules\n\n");
	});

	test("init refuses to overwrite an unmanaged LDR.md", async () => {
		const root = await temporaryDirectory();
		await writeFile(join(root, "LDR.md"), "# Mine\n");
		await expect(initProject(root, template)).rejects.toThrow("not managed by pi-ldr");
	});

	test("deinit preserves records and unrelated AGENTS.md content", async () => {
		const root = await temporaryDirectory();
		await writeFile(join(root, "AGENTS.md"), "# Project rules\n");
		await initProject(root, template);
		await writeFile(join(root, "docs/specs/kept.md"), "# Existing decision\n");

		const result = await deinitProject(root);
		expect(result.removed).toContain("LDR.md");
		expect(result.preserved).toContain("docs/specs/ (contains decision records)");
		expect(await readFile(join(root, "AGENTS.md"), "utf8")).toBe("# Project rules\n");
		expect(await readFile(join(root, "docs/specs/kept.md"), "utf8")).toBe("# Existing decision\n");
	});

	test("deinit removes an empty specs directory and managed-only AGENTS.md", async () => {
		const root = await temporaryDirectory();
		await initProject(root, template);
		const result = await deinitProject(root);
		expect(result.removed).toContain("docs/specs/ (empty)");
		await expect(readFile(join(root, "AGENTS.md"), "utf8")).rejects.toThrow();
	});
});

describe("git-linked work", () => {
	async function initializedRepository(): Promise<string> {
		const root = await temporaryDirectory();
		await mustGit(root, "init", "-b", "master");
		await mustGit(root, "config", "user.name", "Pi LDR Test");
		await mustGit(root, "config", "user.email", "pi-ldr@example.test");
		await initProject(root, template);
		await mustGit(root, "add", ".");
		await mustGit(root, "commit", "-m", "chore: initialize LDR");
		return root;
	}

	test("creates and switches to the linked feature branch with a brief", async () => {
		const root = await initializedRepository();
		// Empty directories are not tracked by Git, so a fresh clone may not have docs/specs yet.
		await rm(join(root, "docs/specs"), { recursive: true });
		const result = await newWork(root, "Add OAuth Login", gitExec);
		expect(result).toEqual({
			branch: "feature/add-oauth-login",
			specPath: "docs/specs/add-oauth-login.md",
			slug: "add-oauth-login",
		});
		expect(await mustGit(root, "branch", "--show-current")).toBe("feature/add-oauth-login");
		expect(await readFile(join(root, result.specPath), "utf8")).toStartWith("# Work: Add OAuth Login\n\n## Brief");
		expect(await currentSpec(root, gitExec)).toEqual({
			path: result.specPath,
			content: await readFile(join(root, result.specPath), "utf8"),
		});
	});

	test("refuses to start work from a dirty tree", async () => {
		const root = await initializedRepository();
		await writeFile(join(root, "dirty.txt"), "dirty\n");
		await expect(newWork(root, "blocked work", gitExec)).rejects.toThrow("working tree is not clean");
		expect(await mustGit(root, "branch", "--show-current")).toBe("master");
	});

	test("rejects an existing decision-record collision", async () => {
		const root = await initializedRepository();
		await writeFile(join(root, "docs/specs/collision.md"), "existing\n");
		await mustGit(root, "add", ".");
		await mustGit(root, "commit", "-m", "docs: add existing record");
		await expect(newWork(root, "collision", gitExec)).rejects.toThrow("already exists");
	});
});
