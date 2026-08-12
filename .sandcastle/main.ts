// Spec-first Sequential Reviewer — implement-then-review loop, in place
//
// A batch is scoped to a *spec*: a GitHub issue labelled `spec` that acts as
// an umbrella tracking issue. Its slices are the spec's **sub-issues** (the
// GitHub native parent→child link) that a human has released by labelling
// them `ready-for-agent`. Being a sub-issue attaches a slice to the spec;
// the `ready-for-agent` label is the separate release gate that lets it into
// the queue. Both must be true for a slice to be worked.
//
// Each iteration runs two phases directly on the current branch:
//   Phase 1 (Implement): an agent picks the next open, released slice of the
//                        batch, implements it, and commits.
//   Phase 2 (Review):    a second agent reviews exactly this iteration's
//                        commits and either approves or amends them in place.
//
// No worktree, no sandbox, no `sandcastle/*` branches, no merge phase: agents
// run on the host with the `head` branch strategy, so commits land on the
// branch this checkout is already on. That fits a per-workspace worktree flow
// where results belong on the workspace branch.
//
// Usage:
//   pnpm sandcastle [maxIterations] [spec]
// e.g. one implement→review cycle over the whole ready-for-agent queue:
//   pnpm sandcastle 1
// or scoped to the released slices of one spec:
//   pnpm sandcastle 5 42

import { execFileSync } from "node:child_process";
import * as sandcastle from "@ai-hero/sandcastle";
import { noSandbox } from "@ai-hero/sandcastle/sandboxes/no-sandbox";
import { cancel, intro, isCancel, outro, select, text } from "@clack/prompts";

const USAGE = "Usage: pnpm sandcastle [maxIterations] [spec]";

const RELEASE_LABEL = "ready-for-agent";

const parsePositiveInteger = (arg: string): number | undefined => {
  if (!/^\d+$/.test(arg)) return undefined;
  const value = Number(arg);
  return value > 0 ? value : undefined;
};

// ---------------------------------------------------------------------------
// GitHub queries
// ---------------------------------------------------------------------------

// The open umbrella issues a run can scope itself to.
const listOpenSpecIssues = (): { number: number; title: string }[] =>
  JSON.parse(
    execFileSync(
      "gh",
      [
        "issue",
        "list",
        "--state",
        "open",
        "--label",
        "spec",
        "--limit",
        "100",
        "--json",
        "number,title",
      ],
      { encoding: "utf8" },
    ),
  );

type SubIssue = {
  number: number;
  state: "open" | "closed";
  labels: string[];
};

// A spec's released, still-open slices — a slice must be both a sub-issue of
// the spec and carry the release label. GitHub caps sub-issues at 100 per
// parent, so one page always holds them all; gh fills {owner}/{repo} from the
// current repo's remote.
const fetchReleasedOpenSlices = (spec: number): number[] => {
  const subIssues: SubIssue[] = JSON.parse(
    execFileSync(
      "gh",
      [
        "api",
        `repos/{owner}/{repo}/issues/${spec}/sub_issues?per_page=100`,
        "--jq",
        "[.[] | {number, state, labels: [.labels[].name]}]",
      ],
      { encoding: "utf8" },
    ),
  );
  return subIssues
    .filter(
      (issue) => issue.state === "open" && issue.labels.includes(RELEASE_LABEL),
    )
    .map((issue) => issue.number);
};

// Size of the queue a run would work: released open slices for a spec, or the
// whole open ready-for-agent queue. Drives the suggested iteration cap.
const countOpenSlices = (spec: number | undefined): number => {
  if (spec !== undefined) return fetchReleasedOpenSlices(spec).length;
  const issues: unknown[] = JSON.parse(
    execFileSync(
      "gh",
      [
        "issue",
        "list",
        "--state",
        "open",
        "--label",
        RELEASE_LABEL,
        "--limit",
        "100",
        "--json",
        "number",
      ],
      { encoding: "utf8" },
    ),
  );
  return issues.length;
};

// One implement→review cycle per open slice, plus slack for reviewer bounces.
const defaultMaxIterations = (openSliceCount: number): number =>
  openSliceCount + 2;

// ---------------------------------------------------------------------------
// Interactive picker
//
// Reached only when Sandcastle is launched with no arguments on a TTY (e.g.
// the Conductor run button). It asks which batch to run — one of the open
// specs, or the whole queue — then suggests an iteration cap sized to that
// batch. Any positional argument bypasses it for a deterministic launch.
// ---------------------------------------------------------------------------

const WHOLE_QUEUE = "whole-queue";
const MANUAL_ENTRY = "manual-entry";

const exitOnCancel = <T>(value: T | symbol): T => {
  if (isCancel(value)) {
    cancel("Run cancelled.");
    process.exit(1);
  }
  return value;
};

const pickBatchInteractively = async (): Promise<{
  spec: number | undefined;
  maxIterations: number;
}> => {
  intro("Sandcastle");

  const chosen = exitOnCancel(
    await select({
      message: "Which batch should this run work on?",
      options: [
        ...listOpenSpecIssues().map((issue) => ({
          value: String(issue.number),
          label: `#${issue.number} ${issue.title}`,
        })),
        { value: WHOLE_QUEUE, label: "Whole ready-for-agent queue (no spec)" },
        { value: MANUAL_ENTRY, label: "Enter a spec number manually" },
      ],
    }),
  );

  let spec: number | undefined;
  if (chosen === WHOLE_QUEUE) {
    spec = undefined;
  } else if (chosen === MANUAL_ENTRY) {
    const entered = exitOnCancel(
      await text({
        message: "Spec issue number",
        validate: (value) =>
          /^[1-9]\d*$/.test(value ?? "")
            ? undefined
            : "Enter a positive issue number.",
      }),
    );
    spec = Number(entered);
  } else {
    spec = Number(chosen);
  }

  // Empty input falls back to the suggested cap via defaultValue.
  const suggested = String(defaultMaxIterations(countOpenSlices(spec)));
  const maxIterations = exitOnCancel(
    await text({
      message: "Max implement→review iterations",
      placeholder: suggested,
      defaultValue: suggested,
      validate: (value) =>
        value === undefined || value === "" || /^[1-9]\d*$/.test(value)
          ? undefined
          : "Enter a positive integer.",
    }),
  );

  outro(
    spec === undefined
      ? `Whole ${RELEASE_LABEL} queue, up to ${maxIterations} iterations.`
      : `Spec #${spec}, up to ${maxIterations} iterations.`,
  );
  return { spec, maxIterations: Number(maxIterations) };
};

// ---------------------------------------------------------------------------
// Launch: resolve spec + iteration cap
//
// Any positional argument bypasses the picker for a deterministic launch.
// A fully argless invocation opens the picker on a TTY, and falls back to the
// whole queue when there is no TTY to ask on.
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);
if (argv.length > 2) {
  console.error(`Too many arguments. ${USAGE}`);
  process.exit(1);
}

let SPEC: number | undefined;
let MAX_ITERATIONS: number;

if (argv.length === 0 && process.stdin.isTTY && process.stdout.isTTY) {
  ({ spec: SPEC, maxIterations: MAX_ITERATIONS } =
    await pickBatchInteractively());
} else {
  const [iterationsArg, specArg] = argv;

  // First positional caps the implement→review cycles (each works one slice).
  MAX_ITERATIONS =
    iterationsArg === undefined ? 10 : (parsePositiveInteger(iterationsArg) ?? 0);
  if (MAX_ITERATIONS === 0) {
    console.error(`maxIterations must be a positive integer. ${USAGE}`);
    process.exit(1);
  }

  // Second positional scopes the queue to one spec's released sub-issues;
  // omitted means the whole ready-for-agent queue.
  if (specArg !== undefined) {
    SPEC = parsePositiveInteger(specArg);
    if (SPEC === undefined) {
      console.error(`spec must be a positive issue number. ${USAGE}`);
      process.exit(1);
    }
  }
}

// ---------------------------------------------------------------------------
// Batch resolution
//
// A scoped run resolves its queue up front from the spec's sub-issues and
// aborts loudly when nothing is released — rather than letting an agent report
// COMPLETE over a query that silently matched nothing. The queue is passed to
// the implement prompt as a jq fragment that narrows its issue query to these
// exact slice numbers, so the numbers the runner logs and the issues the agent
// sees cannot drift.
// ---------------------------------------------------------------------------

// jq fragment inserted after `.[]` in the implement prompt's issue query.
// Empty for a whole-queue run, leaving the query unfiltered.
let specFilter = "";
if (SPEC !== undefined) {
  const openNumbers = fetchReleasedOpenSlices(SPEC);
  if (openNumbers.length === 0) {
    console.error(
      `Spec #${SPEC} has no open sub-issues carrying the ${RELEASE_LABEL} label — its queue is empty.\n` +
        `Attach slices to the spec as GitHub sub-issues and release them with:\n` +
        `  gh issue edit <number> --add-label ${RELEASE_LABEL}`,
    );
    process.exit(1);
  }
  specFilter = `| select(.number | IN(${openNumbers.join(", ")}))`;
  console.log(
    `Scope: Spec #${SPEC} — slices ${openNumbers.map((n) => `#${n}`).join(", ")}`,
  );
} else {
  console.log(`Scope: whole ${RELEASE_LABEL} queue`);
}

const agent = sandcastle.claudeCode("claude-opus-4-8");

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

for (let iteration = 1; iteration <= MAX_ITERATIONS; iteration++) {
  console.log(`\n=== Iteration ${iteration}/${MAX_ITERATIONS} ===\n`);

  // Tip of the branch before the implementer runs. The reviewer diffs against
  // this, so each review covers exactly one iteration's work.
  const base = execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();

  // -------------------------------------------------------------------------
  // Phase 1: Implement
  //
  // The agent picks the next open, released slice of the batch, implements it
  // (RGR: Red → Green → Repeat → Refactor), and commits on the current branch.
  // One iteration so each outer pass implements a single slice before review;
  // a higher value would let one agent drain the batch and skip per-slice
  // review.
  // -------------------------------------------------------------------------
  const implement = await sandcastle.run({
    name: "implementer",
    maxIterations: 1,
    agent,
    sandbox: noSandbox(),
    branchStrategy: { type: "head" },
    promptFile: "./.sandcastle/implement-prompt.md",
    promptArgs: {
      // Narrows the prompt's issue query to the batch's slice numbers; empty
      // for whole-queue runs. Closed slices drop out via the query's
      // --state open, so the fragment stays valid across iterations.
      SPEC_FILTER: specFilter,
    },
  });

  if (implement.commits.length === 0) {
    // No commits means the backlog is empty or every remaining slice is
    // blocked — nothing left to implement or review, so stop.
    console.log("Implementer made no commits. Stopping.");
    break;
  }

  console.log(
    `\nImplemented on ${implement.branch} (${implement.commits.length} commit(s)).`,
  );

  // -------------------------------------------------------------------------
  // Phase 2: Review
  //
  // A second agent reviews everything committed since {{BASE}} — exactly this
  // iteration's work — and either approves or amends it in place.
  // -------------------------------------------------------------------------
  await sandcastle.run({
    name: "reviewer",
    maxIterations: 1,
    agent,
    sandbox: noSandbox(),
    branchStrategy: { type: "head" },
    promptFile: "./.sandcastle/review-prompt.md",
    promptArgs: { BASE: base },
  });

  console.log("\nReview complete.");
}

console.log("\nAll done.");
