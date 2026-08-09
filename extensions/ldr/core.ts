import { randomUUID } from "node:crypto";
import { access, lstat, mkdir, readFile, readdir, rename, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export const LDR_DOCUMENT_MARKER = "<!-- pi-ldr:document -->";
export const AGENTS_START_MARKER = "<!-- pi-ldr:agents:start -->";
export const AGENTS_END_MARKER = "<!-- pi-ldr:agents:end -->";
const AGENTS_OWNED_PREFIX = "\n\n";
const AGENTS_OWNED_SUFFIX = "\n";

export const MANAGED_AGENTS_SECTION = `${AGENTS_START_MARKER}
### Linked Decision Records (LDR) — When to Use

Use LDRs for planned work that needs durable product or technical decision history:

- new features
- substantial behavior changes
- cross-cutting refactors
- architecture, data model, API, integration, or workflow decisions
- bug fixes large enough to require product/design clarification or traceable trade-offs

Do not create a new LDR for:

- research, code questions, investigations, or explanations
- implementation work already covered by an existing feature LDR
- bugs found while implementing an active feature; fix them under the existing LDR unless they materially change scope or design
- small local refactors
- routine bug fixes
- tests, docs, chores, dependency updates, or tooling changes

When work is covered by an existing LDR, continue using that LDR. Update it only when scope, requirements, or technical design materially changes.

If unsure whether a task needs an LDR, ask before creating one. Do not block small or exploratory work on LDR setup by default.

### LDR Workflow Gates

- Use one shared kebab-case slug for the \`feature/<work-slug>\` branch and \`docs/specs/<work-slug>.md\` decision record.
- Write the Brief first at product level. Do not include technical design.
- After presenting the Brief, stop and wait for explicit review or approval before writing the Spec.
- Write the Spec as concise technical decisions, contracts, and material failure behavior—not implementation instructions.
- After presenting the Spec, stop and wait for explicit approval before implementation.
- Never chain brief, spec, and implementation phases in one turn.

**MANDATORY: For any LDR-required work, follow \`LDR.md\` exactly.**
${AGENTS_END_MARKER}`;

export type ChangeKind = "created" | "updated" | "unchanged";

export interface InitResult {
	changes: Array<{ path: string; kind: ChangeKind }>;
}

export interface DeinitResult {
	removed: string[];
	preserved: string[];
}

export interface NewWorkResult {
	branch: string;
	specPath: string;
	slug: string;
}

export interface GitResult {
	stdout: string;
	stderr: string;
	code: number;
}

export type GitExec = (args: string[], cwd: string) => Promise<GitResult>;

export class LdrError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "LdrError";
	}
}

function countOccurrences(value: string, needle: string): number {
	let count = 0;
	let offset = 0;
	while (true) {
		const index = value.indexOf(needle, offset);
		if (index === -1) return count;
		count += 1;
		offset = index + needle.length;
	}
}

function managedSectionRange(content: string): { start: number; end: number } | undefined {
	const starts = countOccurrences(content, AGENTS_START_MARKER);
	const ends = countOccurrences(content, AGENTS_END_MARKER);
	if (starts === 0 && ends === 0) return undefined;
	if (starts !== 1 || ends !== 1) {
		throw new LdrError("AGENTS.md has malformed pi-ldr markers; expected exactly one managed section.");
	}

	const start = content.indexOf(AGENTS_START_MARKER);
	const markerEnd = content.indexOf(AGENTS_END_MARKER);
	if (markerEnd < start) {
		throw new LdrError("AGENTS.md has malformed pi-ldr markers; the end marker precedes the start marker.");
	}
	return { start, end: markerEnd + AGENTS_END_MARKER.length };
}

export function reconcileAgentsContent(current: string | undefined): { content: string; kind: ChangeKind } {
	if (current === undefined) {
		return { content: `${MANAGED_AGENTS_SECTION}\n`, kind: "created" };
	}

	const range = managedSectionRange(current);
	if (!range) {
		return {
			content: current
				? `${current}${AGENTS_OWNED_PREFIX}${MANAGED_AGENTS_SECTION}${AGENTS_OWNED_SUFFIX}`
				: `${MANAGED_AGENTS_SECTION}${AGENTS_OWNED_SUFFIX}`,
			kind: "updated",
		};
	}

	const content = `${current.slice(0, range.start)}${MANAGED_AGENTS_SECTION}${current.slice(range.end)}`;
	return { content, kind: content === current ? "unchanged" : "updated" };
}

export function removeManagedAgentsContent(current: string): string {
	const range = managedSectionRange(current);
	if (!range) return current;

	let removalStart = range.start;
	let removalEnd = range.end;
	if (
		removalStart >= AGENTS_OWNED_PREFIX.length &&
		current.slice(removalStart - AGENTS_OWNED_PREFIX.length, removalStart) === AGENTS_OWNED_PREFIX
	) {
		removalStart -= AGENTS_OWNED_PREFIX.length;
	}
	if (current.slice(removalEnd, removalEnd + AGENTS_OWNED_SUFFIX.length) === AGENTS_OWNED_SUFFIX) {
		removalEnd += AGENTS_OWNED_SUFFIX.length;
	}
	return `${current.slice(0, removalStart)}${current.slice(removalEnd)}`;
}

export function slugifyWorkName(name: string): string {
	const slug = name
		.trim()
		.normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "")
		.toLowerCase()
		.replace(/[’']/g, "")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.replace(/-{2,}/g, "-");

	if (!slug) throw new LdrError("Work name must contain at least one letter or number.");
	if (slug.length > 80) throw new LdrError("Work slug must be 80 characters or fewer; choose a more concise name.");
	return slug;
}

export function titleForWork(name: string): string {
	return name
		.trim()
		.replace(/[-_]+/g, " ")
		.replace(/\s+/g, " ")
		.split(" ")
		.map((word) => (word ? `${word[0]!.toUpperCase()}${word.slice(1)}` : word))
		.join(" ");
}

export function briefScaffold(name: string): string {
	return `# Work: ${titleForWork(name)}

## Brief

### Problem
Describe the user, customer, or business problem to solve.

### Desired Outcome
Describe what should be true when this work is complete.

### Scope / Non-goals
State what is in scope and what is explicitly out.

### Caveats / Constraints
List product, business, legal, UX, timing, or operational caveats. Do not include technical design.

### Success Checks
List externally visible checks that confirm the desired outcome.

### Open Questions
List unknowns that must be resolved before or during spec work.

### Refs
- Add links to issues, docs, prior decision records, or external resources.
`;
}

async function pathKind(path: string): Promise<"file" | "directory" | "other" | "missing"> {
	try {
		const info = await lstat(path);
		if (info.isFile()) return "file";
		if (info.isDirectory()) return "directory";
		return "other";
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
		throw error;
	}
}

async function readOptionalFile(path: string): Promise<string | undefined> {
	const kind = await pathKind(path);
	if (kind === "missing") return undefined;
	if (kind !== "file") throw new LdrError(`${path} exists but is not a regular file.`);
	return readFile(path, "utf8");
}

async function atomicWrite(path: string, content: string): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
	let mode: number | undefined;
	try {
		mode = (await stat(path)).mode;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}

	try {
		await writeFile(temporary, content, { encoding: "utf8", mode });
		await rename(temporary, path);
	} catch (error) {
		await rm(temporary, { force: true }).catch(() => undefined);
		throw error;
	}
}

export async function initProject(root: string, ldrTemplate: string): Promise<InitResult> {
	if (!ldrTemplate.includes(LDR_DOCUMENT_MARKER)) {
		throw new LdrError("The packaged LDR.md template is missing its pi-ldr ownership marker.");
	}

	const specsPath = join(root, "docs", "specs");
	const ldrPath = join(root, "LDR.md");
	const agentsPath = join(root, "AGENTS.md");
	const [specsKind, currentLdr, currentAgents] = await Promise.all([
		pathKind(specsPath),
		readOptionalFile(ldrPath),
		readOptionalFile(agentsPath),
	]);

	if (specsKind !== "missing" && specsKind !== "directory") {
		throw new LdrError(`${specsPath} exists but is not a directory.`);
	}
	if (currentLdr !== undefined && !currentLdr.includes(LDR_DOCUMENT_MARKER)) {
		throw new LdrError("LDR.md already exists and is not managed by pi-ldr; move or remove it before initializing.");
	}

	const agents = reconcileAgentsContent(currentAgents);
	const normalizedTemplate = ldrTemplate.endsWith("\n") ? ldrTemplate : `${ldrTemplate}\n`;
	const ldrKind: ChangeKind = currentLdr === undefined ? "created" : currentLdr === normalizedTemplate ? "unchanged" : "updated";
	const changes: InitResult["changes"] = [
		{ path: "docs/specs/", kind: specsKind === "missing" ? "created" : "unchanged" },
		{ path: "LDR.md", kind: ldrKind },
		{ path: "AGENTS.md (managed LDR section)", kind: agents.kind },
	];

	if (specsKind === "missing") await mkdir(specsPath, { recursive: true });
	if (ldrKind !== "unchanged") await atomicWrite(ldrPath, normalizedTemplate);
	if (agents.kind !== "unchanged") await atomicWrite(agentsPath, agents.content);
	return { changes };
}

export async function deinitProject(root: string): Promise<DeinitResult> {
	const specsPath = join(root, "docs", "specs");
	const ldrPath = join(root, "LDR.md");
	const agentsPath = join(root, "AGENTS.md");
	const [specsKind, currentLdr, currentAgents] = await Promise.all([
		pathKind(specsPath),
		readOptionalFile(ldrPath),
		readOptionalFile(agentsPath),
	]);

	if (specsKind !== "missing" && specsKind !== "directory") {
		throw new LdrError(`${specsPath} exists but is not a directory.`);
	}
	const nextAgents = currentAgents === undefined ? undefined : removeManagedAgentsContent(currentAgents);
	const specsEntries = specsKind === "directory" ? await readdir(specsPath) : [];
	const removeLdr = currentLdr !== undefined && currentLdr.includes(LDR_DOCUMENT_MARKER);

	const removed: string[] = [];
	const preserved: string[] = [];
	if (removeLdr) {
		await rm(ldrPath);
		removed.push("LDR.md");
	} else if (currentLdr !== undefined) {
		preserved.push("LDR.md (not managed by pi-ldr)");
	}

	if (currentAgents !== undefined && nextAgents !== currentAgents) {
		if (nextAgents === "") await rm(agentsPath);
		else await atomicWrite(agentsPath, nextAgents);
		removed.push("Managed LDR section from AGENTS.md");
	} else if (currentAgents !== undefined) {
		preserved.push("AGENTS.md (no managed LDR section found)");
	}

	if (specsKind === "directory" && specsEntries.length === 0) {
		await rmdir(specsPath);
		removed.push("docs/specs/ (empty)");
	} else if (specsKind === "directory") {
		preserved.push("docs/specs/ (contains decision records)");
	}
	return { removed, preserved };
}

async function git(exec: GitExec, cwd: string, args: string[], expectedCodes: number[] = [0]): Promise<GitResult> {
	const result = await exec(args, cwd);
	if (!expectedCodes.includes(result.code)) {
		const detail = result.stderr.trim() || result.stdout.trim() || `exit code ${result.code}`;
		throw new LdrError(`git ${args.join(" ")} failed: ${detail}`);
	}
	return result;
}

export async function findGitRoot(exec: GitExec, cwd: string): Promise<string> {
	const result = await git(exec, cwd, ["rev-parse", "--show-toplevel"]);
	const root = result.stdout.trim();
	if (!root) throw new LdrError("Could not determine the Git repository root.");
	return root;
}

async function assertIntegrated(root: string): Promise<void> {
	const [ldr, agents, specsKind] = await Promise.all([
		readOptionalFile(join(root, "LDR.md")),
		readOptionalFile(join(root, "AGENTS.md")),
		pathKind(join(root, "docs", "specs")),
	]);
	if (specsKind !== "missing" && specsKind !== "directory") {
		throw new LdrError("LDR integration is incomplete: docs/specs exists but is not a directory.");
	}
	if (!ldr?.includes(LDR_DOCUMENT_MARKER) || !agents || !managedSectionRange(agents)) {
		throw new LdrError("LDR integration is incomplete. Run /ldr init first.");
	}
}

export async function newWork(root: string, name: string, exec: GitExec): Promise<NewWorkResult> {
	const trimmedName = name.trim();
	if (!trimmedName) throw new LdrError("Usage: /ldr new <name>");
	const statusResult = await git(exec, root, ["status", "--porcelain=v1", "--untracked-files=all"]);
	if (statusResult.stdout.trim()) {
		throw new LdrError("Git working tree is not clean. Commit, stash, or remove current changes before /ldr new.");
	}

	await assertIntegrated(root);
	await git(exec, root, ["rev-parse", "--verify", "HEAD"]);
	const slug = slugifyWorkName(trimmedName);
	const branch = `feature/${slug}`;
	const relativeSpecPath = `docs/specs/${slug}.md`;
	const specPath = join(root, relativeSpecPath);

	try {
		await access(specPath);
		throw new LdrError(`${relativeSpecPath} already exists. Choose a disambiguated work name.`);
	} catch (error) {
		if (error instanceof LdrError) throw error;
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}

	const localBranch = await git(exec, root, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], [0, 1]);
	if (localBranch.code === 0) throw new LdrError(`Branch ${branch} already exists. Choose a disambiguated work name.`);
	const remoteBranches = await git(exec, root, ["for-each-ref", "--format=%(refname:short)", "refs/remotes"]);
	if (remoteBranches.stdout.split("\n").some((ref) => ref.endsWith(`/${branch}`))) {
		throw new LdrError(`A remote ${branch} branch already exists. Choose a disambiguated work name.`);
	}

	const currentBranchResult = await git(exec, root, ["symbolic-ref", "--quiet", "--short", "HEAD"], [0, 1]);
	const currentBranch = currentBranchResult.code === 0 ? currentBranchResult.stdout.trim() : undefined;
	const currentCommit = (await git(exec, root, ["rev-parse", "HEAD"])).stdout.trim();
	await git(exec, root, ["switch", "-c", branch]);

	try {
		await mkdir(dirname(specPath), { recursive: true });
		await writeFile(specPath, briefScaffold(trimmedName), { encoding: "utf8", flag: "wx" });
	} catch (error) {
		const rollbackErrors: string[] = [];
		const restoreArgs = currentBranch ? ["switch", currentBranch] : ["switch", "--detach", currentCommit];
		try {
			await git(exec, root, restoreArgs);
		} catch (rollbackError) {
			rollbackErrors.push((rollbackError as Error).message);
		}
		try {
			await git(exec, root, ["branch", "-D", branch]);
		} catch (rollbackError) {
			rollbackErrors.push((rollbackError as Error).message);
		}
		const suffix = rollbackErrors.length ? ` Rollback also failed: ${rollbackErrors.join("; ")}` : "";
		throw new LdrError(`Could not create ${relativeSpecPath}: ${(error as Error).message}.${suffix}`);
	}

	return { branch, specPath: relativeSpecPath, slug };
}

export async function currentSpec(root: string, exec: GitExec): Promise<{ path: string; content: string }> {
	const branchResult = await git(exec, root, ["symbolic-ref", "--quiet", "--short", "HEAD"], [0, 1]);
	if (branchResult.code !== 0) throw new LdrError("HEAD is detached; there is no current LDR feature branch.");
	const branch = branchResult.stdout.trim();
	const match = /^feature\/([a-z0-9]+(?:-[a-z0-9]+)*)$/.exec(branch);
	if (!match) throw new LdrError(`Current branch ${branch} is not an LDR feature branch (feature/<work-slug>).`);
	const relativePath = `docs/specs/${match[1]}.md`;
	const absolutePath = join(root, relativePath);
	const content = await readOptionalFile(absolutePath);
	if (content === undefined) throw new LdrError(`Current branch expects ${relativePath}, but that decision record does not exist.`);
	return { path: relativePath, content };
}
