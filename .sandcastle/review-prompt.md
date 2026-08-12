# Task

Review the code committed in this iteration — everything since `{{BASE}}` — and
improve its clarity, consistency, and maintainability while preserving exact
functionality. Amend in place on the current branch.

# Context

## Changes this iteration

!`git diff {{BASE}}...HEAD`

## Commits this iteration

!`git log {{BASE}}..HEAD --oneline`

# Review process

1. **Understand the change**: read the diff and commits above to understand the
   intent. The `Closes #<n>` line ties the work back to its slice — pull the
   slice in with `gh issue view <n>` if you need the acceptance criteria.

2. **Analyze for improvements**: look for opportunities to:
   - Reduce unnecessary complexity and nesting
   - Eliminate redundant code and abstractions
   - Improve readability through clear variable and function names
   - Consolidate related logic
   - Remove comments that merely restate obvious code
   - Avoid nested ternary operators — prefer switch statements or if/else chains
   - Choose clarity over brevity — explicit code often beats overly compact code

3. **Check correctness**:
   - Does the implementation match the slice's intent? Are edge cases handled?
   - Are new/changed behaviours covered by tests, where a test setup exists?
   - Are there unsafe casts, `any` types, or unchecked assumptions?
   - Does the change introduce injection vulnerabilities, credential leaks, or
     other security issues?

4. **Maintain balance**: avoid over-simplification that reduces clarity, creates
   overly clever solutions, combines too many concerns, removes helpful
   abstractions, or makes the code harder to debug or extend.

5. **Apply project standards**: follow @.sandcastle/CODING_STANDARDS.md and the
   conventions in `AGENTS.md` / `CLAUDE.md`.

6. **Preserve functionality**: never change what the code does — only how it
   does it. All original behaviours and outputs must remain intact.

# Execution

If you find improvements to make:

1. Make the changes directly on the current branch.
2. Run `pnpm check-types` (and `pnpm build:plugin` if the plugin bundle is
   affected) to ensure nothing is broken.
3. Commit describing the refinements.

If the code is already clean and well-structured, do nothing.

Once complete, output <promise>COMPLETE</promise>.
