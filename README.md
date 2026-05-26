# diffsense

> Built by Vraj Desai — 90% written by me, 10% assisted by Claude AI.

**Semantic diff analyzer for TypeScript, JavaScript & Python — understand what your code actually *does* differently, not just what lines changed.**

`git diff` shows you which lines moved. `diffsense` shows you which behaviors changed.

```
npm install -g diffsense
```

---

## The problem

`git diff` tells you *what* changed syntactically. It can't tell you:

- Was error handling removed from this function?
- Did this API's signature silently break callers?
- Is this a safe refactor or a behavior shift?
- Which timeout was shortened and by how much?

diffsense answers all of these by parsing both versions of each file into an AST and comparing function behavior directly.

---

## Demo

```
$ diffsense diff main feature/auth-refactor

  diffsense  semantic diff analyzer
  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  from main  →  feature/auth-refactor
  files 4   changes 9
  risk  2 HIGH  ·  3 MEDIUM  ·  4 LOW
  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  ▶ src/auth/session.ts  +12 -8  HIGH

    ⚠  RISK_ADDED      `validateSession` removed 2 null/undefined guard(s)
       before: !token, token == null
       after:  (no guard)
    ⚠  RISK_ADDED      `validateSession` removed 1 try/catch block(s) — unhandled errors possible
    ~  LOGIC_CHANGED   `validateSession` added 1 conditional branch(es)
       before: 3 branches
       after:  4 branches

  ▶ src/api/users/route.ts  +5 -2  HIGH

    ⬡  API_CHANGED     `getUser` became async — callers may break
       before: sync
       after:  async
    ⬡  API_CHANGED     `getUser` return type changed
       before: User | null
       after:  Promise<User>

  ▶ src/db/pool.ts  +3 -1  HIGH

    ⚙  CONFIG          `DB_TIMEOUT` changed
       before: 5000
       after:  500

  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  AI Behavioral Summary
  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  This diff introduces significant risk in the auth layer. validateSession
  now runs without null guards or a try/catch, meaning a missing or
  malformed token will throw an unhandled exception rather than returning
  false — a potential 500 on every unauthenticated request. The DB_TIMEOUT
  drop from 5000ms to 500ms will cause failures under any moderate load.
  The getUser async change is a breaking API contract shift; any caller
  using the return value directly without await will silently get a Promise
  object. These three changes together suggest this branch is not
  merge-ready.
```

---

## Install

```bash
npm install -g diffsense
```

Or run without installing:

```bash
npx diffsense diff HEAD~1 HEAD
```

---

## Usage

### Analyze a diff

```bash
# Last commit (default)
diffsense diff

# Two branches
diffsense diff main feature/my-branch

# Two commits
diffsense diff abc123 def456

# Only show HIGH risk changes
diffsense diff main HEAD --risk HIGH

# Skip AI narrative (no API key needed)
diffsense diff HEAD~1 HEAD --no-ai

# Machine-readable output (pipe to CI, Slack bots, etc.)
diffsense diff main HEAD --json
```

### Inspect a file

```bash
diffsense explain src/auth/session.ts
# → lists all functions, signatures, return types
```

---

## Change categories

| Icon | Category | What it means | Risk |
|------|----------|---------------|------|
| ⚠ | `RISK_ADDED` | Removed null check, try/catch, or shortened timeout | HIGH |
| ⬡ | `API_CHANGED` | Function signature, return type, or async modifier changed | HIGH |
| ~ | `LOGIC_CHANGED` | Conditional branches added or removed | MEDIUM |
| ⊞ | `DEPENDENCY` | Imports removed (callers may break) | MEDIUM |
| ⚙ | `CONFIG` | Constants or config values changed | MEDIUM |
| ✓ | `RISK_REMOVED` | Null guards or error handling added | LOW |
| + | `BEHAVIOR_NEW` | New function added | LOW |
| ↺ | `REFACTOR` | Structural change, equivalent behavior | NONE |
| ✗ | `DEAD_CODE` | Function removed | NONE |

---

## AI narrative (optional)

diffsense includes a plain-English behavioral summary by default — **no API key needed**. It uses a free hosted backend (10 narrations/day per IP).

```bash
diffsense diff main HEAD   # AI narrative included automatically
```

If you have your own `ANTHROPIC_API_KEY`, diffsense will use it directly instead (unlimited, faster):

```bash
export ANTHROPIC_API_KEY=sk-ant-...
diffsense diff main HEAD
```

Use `--no-ai` to skip the narrative entirely (faster, purely structural output):

```bash
diffsense diff HEAD~1 HEAD --no-ai
```

---

## CI / pre-merge hook

Exit code is `1` when HIGH risk changes are found, `0` otherwise. Use it as a pre-merge gate:

```yaml
# .github/workflows/diffsense.yml
- name: Semantic diff check
  run: npx diffsense diff ${{ github.event.pull_request.base.sha }} ${{ github.sha }} --no-ai --risk HIGH
  env:
    ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```

Or as a local pre-push hook:

```bash
# .git/hooks/pre-push
#!/bin/sh
diffsense diff origin/main HEAD --no-ai --risk HIGH
```

---

## How it works

1. **Git** — uses `simple-git` to get the file list and retrieve both versions of each changed file
2. **AST parse** — runs `ts-morph` on both versions of each file to build a structural model of every function
3. **Behavioral comparison** — compares null guard sets, branch counts, try/catch blocks, throw statements, timeout values, signatures, and return types between old and new
4. **Classification** — each detected difference is assigned a category and risk level
5. **AI narration** — the structured findings are sent to Claude with a cached system prompt, which writes a plain-English behavioral summary

diffsense analyzes `.ts`, `.tsx`, `.js`, `.jsx`, and `.py` files.

---

## License

MIT
