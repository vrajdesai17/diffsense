import { ChangeCategory, RiskLevel, SemanticChange } from "./types.js";
import { FilePatch } from "./git.js";

interface PyFunction {
  name: string;
  qualifiedName: string;
  isAsync: boolean;
  params: string;
  returnType: string;
  decorators: string[];
  startLine: number;
  branchCount: number;
  tryCount: number;
  raiseCount: number;
  nullGuards: string[];
}

function parseFunctions(content: string): Map<string, PyFunction> {
  const result = new Map<string, PyFunction>();
  const lines = content.split("\n");

  const classStack: { name: string; indent: number }[] = [];
  const fnStack: { fn: PyFunction; indent: number; bodyLines: string[] }[] = [];
  let pendingDecorators: string[] = [];

  const finalize = (fn: PyFunction, bodyLines: string[]) => {
    for (const line of bodyLines) {
      if (/^(if|elif|else\s*:|match)\b/.test(line)) fn.branchCount++;
      if (/^try\s*:/.test(line)) fn.tryCount++;
      if (/^raise\b/.test(line)) fn.raiseCount++;
      if (/\bis\s+None\b|\bif\s+not\s+\w|\bis\s+not\s+None\b/.test(line)) {
        fn.nullGuards.push(line.substring(0, 60));
      }
    }
    result.set(fn.qualifiedName, fn);
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const stripped = raw.trimStart();
    if (!stripped || stripped.startsWith("#")) continue;

    const indent = raw.length - stripped.length;

    // Close classes that are no longer in scope
    while (classStack.length && classStack[classStack.length - 1].indent >= indent) {
      classStack.pop();
    }
    // Close functions that are no longer in scope
    while (fnStack.length && fnStack[fnStack.length - 1].indent >= indent) {
      const { fn, bodyLines } = fnStack.pop()!;
      finalize(fn, bodyLines);
    }

    // Decorator
    if (stripped.startsWith("@")) {
      pendingDecorators.push(stripped.split("(")[0]);
      continue;
    }

    // Class definition
    const classMatch = stripped.match(/^class\s+(\w+)/);
    if (classMatch) {
      classStack.push({ name: classMatch[1], indent });
      pendingDecorators = [];
      continue;
    }

    // Function definition (single-line params only)
    const fnMatch = stripped.match(/^(async\s+)?def\s+(\w+)\s*\(([^)]*)\)\s*(?:->\s*([^:]+?))?\s*:/);
    if (fnMatch) {
      const currentClass = classStack.length ? classStack[classStack.length - 1].name : null;
      const name = fnMatch[2];
      const qualifiedName = currentClass ? `${currentClass}.${name}` : name;
      const fn: PyFunction = {
        name,
        qualifiedName,
        isAsync: !!(fnMatch[1]?.trim()),
        params: fnMatch[3].trim(),
        returnType: fnMatch[4] ? fnMatch[4].trim() : "",
        decorators: [...pendingDecorators],
        startLine: i + 1,
        branchCount: 0,
        tryCount: 0,
        raiseCount: 0,
        nullGuards: [],
      };
      pendingDecorators = [];
      fnStack.push({ fn, indent, bodyLines: [] });
      continue;
    }

    // Accumulate body lines
    if (fnStack.length) {
      const top = fnStack[fnStack.length - 1];
      if (indent > top.indent) {
        top.bodyLines.push(stripped);
      }
    }
  }

  // Flush remaining functions
  while (fnStack.length) {
    const { fn, bodyLines } = fnStack.pop()!;
    finalize(fn, bodyLines);
  }

  return result;
}

function parseImports(content: string): Set<string> {
  const imports = new Set<string>();
  for (const line of content.split("\n")) {
    const s = line.trim();
    const fromMatch = s.match(/^from\s+(\S+)\s+import/);
    const importMatch = s.match(/^import\s+(\S+)/);
    if (fromMatch) imports.add(fromMatch[1]);
    else if (importMatch) imports.add(importMatch[1].split(",")[0].trim());
  }
  return imports;
}

function parseConstants(content: string): Map<string, string> {
  const consts = new Map<string, string>();
  for (const line of content.split("\n")) {
    const match = line.match(/^([A-Z][A-Z0-9_]{2,})\s*=\s*(.+)/);
    if (match) consts.set(match[1], match[2].trim().substring(0, 80));
  }
  return consts;
}

function normalizeParams(params: string): string {
  return params
    .split(",")
    .map((p) => {
      let t = p.trim();
      const colon = t.indexOf(":");
      if (colon > 0) t = t.substring(0, colon).trim();
      const eq = t.indexOf("=");
      if (eq > 0) t = t.substring(0, eq).trim();
      return t;
    })
    .filter((p) => p && p !== "self" && p !== "cls")
    .join(", ");
}

export function analyzePythonDiff(patch: FilePatch): SemanticChange[] {
  const changes: SemanticChange[] = [];
  if (!patch.oldContent.trim() || !patch.newContent.trim()) return changes;

  const oldFns = parseFunctions(patch.oldContent);
  const newFns = parseFunctions(patch.newContent);
  const oldImports = parseImports(patch.oldContent);
  const newImports = parseImports(patch.newContent);
  const oldConsts = parseConstants(patch.oldContent);
  const newConsts = parseConstants(patch.newContent);

  for (const [name, newFn] of newFns) {
    const oldFn = oldFns.get(name);

    if (!oldFn) {
      changes.push({
        category: "BEHAVIOR_NEW",
        risk: "LOW",
        location: `${name} @ ${patch.file}:${newFn.startLine}`,
        description: `New function \`${name}\` added`,
      });
      continue;
    }

    const loc = `${name} @ ${patch.file}:${newFn.startLine}`;

    // Async changed
    if (oldFn.isAsync !== newFn.isAsync) {
      changes.push({
        category: "API_CHANGED",
        risk: "HIGH",
        location: loc,
        description: `\`${name}\` ${newFn.isAsync ? "became async" : "removed async"} — callers may break`,
        before: oldFn.isAsync ? "async" : "sync",
        after: newFn.isAsync ? "async" : "sync",
      });
    }

    // Signature changed
    const oldParams = normalizeParams(oldFn.params);
    const newParams = normalizeParams(newFn.params);
    if (oldParams !== newParams) {
      changes.push({
        category: "API_CHANGED",
        risk: "HIGH",
        location: loc,
        description: `Signature changed in \`${name}\``,
        before: `(${oldParams})`,
        after: `(${newParams})`,
      });
    }

    // Return type annotation changed
    if (oldFn.returnType && newFn.returnType && oldFn.returnType !== newFn.returnType) {
      changes.push({
        category: "API_CHANGED",
        risk: "HIGH",
        location: loc,
        description: `\`${name}\` return type annotation changed`,
        before: oldFn.returnType,
        after: newFn.returnType,
      });
    }

    // Decorator changes
    const removedDec = oldFn.decorators.filter((d) => !newFn.decorators.includes(d));
    const addedDec = newFn.decorators.filter((d) => !oldFn.decorators.includes(d));
    if (removedDec.length || addedDec.length) {
      changes.push({
        category: "API_CHANGED",
        risk: "MEDIUM",
        location: loc,
        description: `\`${name}\` decorator(s) changed`,
        before: removedDec.join(", ") || undefined,
        after: addedDec.join(", ") || undefined,
      });
    }

    // Try/except removed → unhandled exceptions possible
    if (oldFn.tryCount > newFn.tryCount) {
      changes.push({
        category: "RISK_ADDED",
        risk: "HIGH",
        location: loc,
        description: `\`${name}\` removed ${oldFn.tryCount - newFn.tryCount} try/except block(s) — unhandled exceptions possible`,
      });
    } else if (newFn.tryCount > oldFn.tryCount) {
      changes.push({
        category: "RISK_REMOVED",
        risk: "LOW",
        location: loc,
        description: `\`${name}\` added ${newFn.tryCount - oldFn.tryCount} try/except block(s)`,
      });
    }

    // Null/None guards
    const removedGuards = oldFn.nullGuards.filter((g) => !newFn.nullGuards.includes(g));
    if (removedGuards.length) {
      changes.push({
        category: "RISK_ADDED",
        risk: "HIGH",
        location: loc,
        description: `\`${name}\` removed ${removedGuards.length} None guard(s)`,
        before: removedGuards[0],
        after: "(no guard)",
      });
    }
    const addedGuards = newFn.nullGuards.filter((g) => !oldFn.nullGuards.includes(g));
    if (addedGuards.length) {
      changes.push({
        category: "RISK_REMOVED",
        risk: "LOW",
        location: loc,
        description: `\`${name}\` added ${addedGuards.length} None guard(s)`,
        after: addedGuards[0],
      });
    }

    // Branch count
    const branchDelta = newFn.branchCount - oldFn.branchCount;
    if (branchDelta !== 0) {
      changes.push({
        category: "LOGIC_CHANGED",
        risk: "MEDIUM",
        location: loc,
        description: `\`${name}\` ${branchDelta > 0 ? "added" : "removed"} ${Math.abs(branchDelta)} conditional branch(es)`,
        before: `${oldFn.branchCount} branches`,
        after: `${newFn.branchCount} branches`,
      });
    }

    // Raise count
    if (oldFn.raiseCount > newFn.raiseCount) {
      changes.push({
        category: "RISK_ADDED",
        risk: "MEDIUM",
        location: loc,
        description: `\`${name}\` removed ${oldFn.raiseCount - newFn.raiseCount} raise statement(s) — error propagation changed`,
      });
    } else if (newFn.raiseCount > oldFn.raiseCount) {
      changes.push({
        category: "LOGIC_CHANGED",
        risk: "MEDIUM",
        location: loc,
        description: `\`${name}\` added ${newFn.raiseCount - oldFn.raiseCount} raise statement(s)`,
      });
    }
  }

  // Functions removed entirely
  for (const [name, oldFn] of oldFns) {
    if (!newFns.has(name)) {
      changes.push({
        category: "DEAD_CODE",
        risk: "NONE",
        location: `${name} @ ${patch.file}:${oldFn.startLine}`,
        description: `Function \`${name}\` removed`,
      });
    }
  }

  // Import changes
  const addedImports = [...newImports].filter((i) => !oldImports.has(i));
  const removedImports = [...oldImports].filter((i) => !newImports.has(i));
  if (addedImports.length) {
    changes.push({
      category: "DEPENDENCY",
      risk: "LOW",
      location: patch.file,
      description: `Added ${addedImports.length} import(s): ${addedImports.slice(0, 3).join(", ")}`,
      after: addedImports.join(", "),
    });
  }
  if (removedImports.length) {
    changes.push({
      category: "DEPENDENCY",
      risk: "MEDIUM",
      location: patch.file,
      description: `Removed ${removedImports.length} import(s): ${removedImports.slice(0, 3).join(", ")} — verify no callers remain`,
      before: removedImports.join(", "),
    });
  }

  // Config constant changes (ALL_CAPS = value)
  for (const [key, newVal] of newConsts) {
    const oldVal = oldConsts.get(key);
    if (oldVal && oldVal !== newVal) {
      changes.push({
        category: "CONFIG",
        risk: "MEDIUM",
        location: `${key} @ ${patch.file}`,
        description: `Config constant \`${key}\` changed`,
        before: oldVal,
        after: newVal,
      });
    }
  }

  return changes;
}
