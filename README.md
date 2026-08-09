# pi-ldr

A Pi package for managing **Linked Decision Records (LDRs)**. It links each planned unit of work through a shared slug:

- Branch: `feature/work-slug`
- Decision record: `docs/specs/work-slug.md`

The record starts with a product brief and gains a technical spec after the brief is approved.

## Installation

Install from a local checkout:

```sh
pi install /absolute/path/to/pi-ldr
```

Install for the current project only:

```sh
pi install -l /absolute/path/to/pi-ldr
```

Or try the extension without installing it:

```sh
pi -e ./extensions/ldr/index.ts
```

## Usage

### Initialize a project

```text
/ldr init
```

Creates or reconciles `LDR.md`, `docs/specs/`, and the managed LDR section in `AGENTS.md`. Existing project guidance and decision records are preserved. No commit is created.

### Start linked work

```text
/ldr new <name>
```

Requires a clean Git tree. The command creates and switches to `feature/<work-slug>`, then creates `docs/specs/<work-slug>.md` with a brief scaffold.

Example:

```text
/ldr new add team invitations
```

Creates:

```text
feature/add-team-invitations
docs/specs/add-team-invitations.md
```

### View the current record

```text
/ldr view
```

Opens the decision record linked to the current `feature/<work-slug>` branch.

### Remove project integration

```text
/ldr deinit
```

After confirmation, removes the generated `LDR.md`, the managed `AGENTS.md` section, and `docs/specs/` only when empty. Existing records, unrelated guidance, branches, and working changes are preserved.

## Development

```sh
bun test
```
