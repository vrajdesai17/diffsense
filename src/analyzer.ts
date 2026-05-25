import {
  Project,
  SourceFile,
  FunctionDeclaration,
  MethodDeclaration,
  ArrowFunction,
  FunctionExpression,
  Node,
  SyntaxKind,
  IfStatement,
  TryStatement,
  ReturnStatement,
  ThrowStatement,
  CallExpression,
  VariableDeclaration,
  ImportDeclaration,
  PropertyAccessExpression,
  BinaryExpression,
  ConditionalExpression,
} from "ts-morph";
import { ChangeCategory, RiskLevel, SemanticChange } from "./types.js";
import { FilePatch } from "./git.js";

interface FunctionSignature {
  name: string;
  params: string[];
  returnType: string;
  isAsync: boolean;
  startLine: number;
}

interface FunctionBehavior {
  sig: FunctionSignature;
  branchCount: number;         // number of if/else/switch branches
  throwCount: number;          // throw statements
  tryCount: number;            // try/catch blocks
  nullGuards: string[];        // null/undefined checks (e.g. "if (!x)")
  returnPaths: string[];       // return value signatures
  callees: string[];           // functions called internally
  timeoutValues: number[];     // setTimeout/setInterval values
  earlyReturns: number;        // early return count
}

function extractFunctions(source: SourceFile): Map<string, FunctionBehavior> {
  const map = new Map<string, FunctionBehavior>();

  function processFn(
    node: FunctionDeclaration | MethodDeclaration | ArrowFunction | FunctionExpression,
    nameHint: string
  ) {
    const name = nameHint;
    const startLine = node.getStartLineNumber();

    let isAsync = false;
    let params: string[] = [];
    let returnType = "unknown";

    if (Node.isFunctionDeclaration(node) || Node.isMethodDeclaration(node) || Node.isFunctionExpression(node)) {
      isAsync = node.isAsync();
      params = node.getParameters().map((p) => `${p.getName()}: ${p.getType().getText()}`);
      returnType = node.getReturnType().getText();
    } else if (Node.isArrowFunction(node)) {
      isAsync = node.isAsync();
      params = node.getParameters().map((p) => `${p.getName()}: ${p.getType().getText()}`);
      returnType = node.getReturnType().getText();
    }

    const body = node.getBody();
    if (!body) return;

    // Count branches
    const ifStatements = body.getDescendantsOfKind(SyntaxKind.IfStatement);
    const switchStatements = body.getDescendantsOfKind(SyntaxKind.SwitchStatement);
    const branchCount = ifStatements.length + switchStatements.length;

    // Count throws
    const throws = body.getDescendantsOfKind(SyntaxKind.ThrowStatement);

    // Count try/catch
    const trys = body.getDescendantsOfKind(SyntaxKind.TryStatement);

    // Detect null guards: if (!x), if (x == null), x != undefined, x?.y
    const nullGuards: string[] = [];
    body.getDescendantsOfKind(SyntaxKind.IfStatement).forEach((ifStmt) => {
      const cond = ifStmt.getExpression().getText();
      if (
        cond.includes("null") ||
        cond.includes("undefined") ||
        cond.match(/^![\w.]+$/) ||
        cond.match(/^typeof .+ ===/)
      ) {
        nullGuards.push(cond);
      }
    });

    // Detect optional chaining as null guards too
    body.getDescendantsOfKind(SyntaxKind.QuestionDotToken).forEach(() => {
      nullGuards.push("?.");
    });

    // Return paths
    const returns = body.getDescendantsOfKind(SyntaxKind.ReturnStatement);
    const returnPaths = returns.map((r) => {
      const expr = r.getExpression();
      return expr ? expr.getText().substring(0, 60) : "void";
    });

    // Callees (function calls)
    const calls = body.getDescendantsOfKind(SyntaxKind.CallExpression);
    const callees = calls.map((c) => c.getExpression().getText().substring(0, 40));

    // setTimeout/setInterval values
    const timeoutValues: number[] = [];
    calls.forEach((c) => {
      const expr = c.getExpression().getText();
      if (expr === "setTimeout" || expr === "setInterval") {
        const args = c.getArguments();
        if (args[1]) {
          const val = parseInt(args[1].getText(), 10);
          if (!isNaN(val)) timeoutValues.push(val);
        }
      }
    });

    // Early returns (return before last statement)
    const earlyReturns = returns.length > 1 ? returns.length - 1 : 0;

    map.set(name, {
      sig: { name, params, returnType, isAsync, startLine },
      branchCount,
      throwCount: throws.length,
      tryCount: trys.length,
      nullGuards,
      returnPaths,
      callees,
      timeoutValues,
      earlyReturns,
    });
  }

  // Named function declarations
  source.getFunctions().forEach((fn) => {
    const name = fn.getName() || "anonymous";
    processFn(fn, name);
  });

  // Methods in classes
  source.getClasses().forEach((cls) => {
    cls.getMethods().forEach((method) => {
      processFn(method, `${cls.getName() ?? "Class"}.${method.getName()}`);
    });
  });

  // Arrow functions / function expressions assigned to variables
  source.getVariableDeclarations().forEach((decl) => {
    const init = decl.getInitializer();
    if (init && (Node.isArrowFunction(init) || Node.isFunctionExpression(init))) {
      processFn(init, decl.getName());
    }
  });

  return map;
}

function extractImports(source: SourceFile): Set<string> {
  return new Set(
    source.getImportDeclarations().map((imp) => imp.getModuleSpecifierValue())
  );
}

function extractConstants(source: SourceFile): Map<string, string> {
  const map = new Map<string, string>();
  source.getVariableDeclarations().forEach((decl) => {
    const init = decl.getInitializer();
    if (init && !Node.isArrowFunction(init) && !Node.isFunctionExpression(init)) {
      map.set(decl.getName(), init.getText().substring(0, 80));
    }
  });
  return map;
}

function riskForCategory(cat: ChangeCategory): RiskLevel {
  switch (cat) {
    case "RISK_ADDED": return "HIGH";
    case "API_CHANGED": return "HIGH";
    case "LOGIC_CHANGED": return "MEDIUM";
    case "RISK_REMOVED": return "LOW";
    case "BEHAVIOR_NEW": return "LOW";
    case "DEPENDENCY": return "MEDIUM";
    case "CONFIG": return "MEDIUM";
    case "REFACTOR": return "NONE";
    case "DEAD_CODE": return "NONE";
    default: return "NONE";
  }
}

export function analyzeFileDiff(patch: FilePatch): SemanticChange[] {
  const changes: SemanticChange[] = [];
  const project = new Project({ useInMemoryFileSystem: true, skipAddingFilesFromTsConfig: true });

  const fileName = patch.file.split("/").pop() ?? patch.file;
  const isTS = fileName.endsWith(".ts") || fileName.endsWith(".tsx");

  if (!isTS && !fileName.endsWith(".js") && !fileName.endsWith(".jsx")) {
    return changes;
  }

  let oldSource: SourceFile | undefined;
  let newSource: SourceFile | undefined;

  try {
    if (patch.oldContent.trim()) {
      oldSource = project.createSourceFile(`old_${fileName}`, patch.oldContent, { overwrite: true });
    }
    if (patch.newContent.trim()) {
      newSource = project.createSourceFile(`new_${fileName}`, patch.newContent, { overwrite: true });
    }
  } catch {
    return changes;
  }

  if (!oldSource || !newSource) return changes;

  const oldFns = extractFunctions(oldSource);
  const newFns = extractFunctions(newSource);
  const oldImports = extractImports(oldSource);
  const newImports = extractImports(newSource);
  const oldConsts = extractConstants(oldSource);
  const newConsts = extractConstants(newSource);

  // --- Compare functions that exist in both versions ---
  for (const [name, newBehavior] of newFns) {
    const oldBehavior = oldFns.get(name);

    if (!oldBehavior) {
      // New function added
      changes.push({
        category: "BEHAVIOR_NEW",
        risk: "LOW",
        location: `${name} @ ${patch.file}:${newBehavior.sig.startLine}`,
        description: `New function \`${name}\` added`,
      });
      continue;
    }

    const loc = `${name} @ ${patch.file}:${newBehavior.sig.startLine}`;

    // 1. Signature change (API_CHANGED) — normalize whitespace/trailing commas to avoid formatting-only false positives
    const normalize = (s: string) =>
      s.replace(/\s+/g, " ")              // collapse all whitespace
        .replace(/,\s*([}\]])/g, "$1")    // remove trailing commas before } ]
        .replace(/\s*([{},:<>?[\]])\s*/g, "$1") // strip spaces around punctuation
        .trim();
    const oldParams = normalize(oldBehavior.sig.params.join(", "));
    const newParams = normalize(newBehavior.sig.params.join(", "));
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

    // 2. Null guards removed (RISK_ADDED)
    const removedGuards = oldBehavior.nullGuards.filter(
      (g) => !newBehavior.nullGuards.includes(g)
    );
    if (removedGuards.length > 0) {
      changes.push({
        category: "RISK_ADDED",
        risk: "HIGH",
        location: loc,
        description: `\`${name}\` removed ${removedGuards.length} null/undefined guard(s)`,
        before: removedGuards.join(", "),
        after: "(no guard)",
      });
    }

    // 3. Null guards added (RISK_REMOVED)
    const addedGuards = newBehavior.nullGuards.filter(
      (g) => !oldBehavior.nullGuards.includes(g)
    );
    if (addedGuards.length > 0) {
      changes.push({
        category: "RISK_REMOVED",
        risk: "LOW",
        location: loc,
        description: `\`${name}\` added ${addedGuards.length} null/undefined guard(s)`,
        after: addedGuards.join(", "),
      });
    }

    // 4. Try/catch removed (RISK_ADDED)
    if (oldBehavior.tryCount > newBehavior.tryCount) {
      const removed = oldBehavior.tryCount - newBehavior.tryCount;
      changes.push({
        category: "RISK_ADDED",
        risk: "HIGH",
        location: loc,
        description: `\`${name}\` removed ${removed} try/catch block(s) — unhandled errors possible`,
      });
    }

    // 5. Try/catch added (RISK_REMOVED)
    if (newBehavior.tryCount > oldBehavior.tryCount) {
      const added = newBehavior.tryCount - oldBehavior.tryCount;
      changes.push({
        category: "RISK_REMOVED",
        risk: "LOW",
        location: loc,
        description: `\`${name}\` added ${added} try/catch block(s)`,
      });
    }

    // 6. Branch count changed (LOGIC_CHANGED)
    const branchDelta = newBehavior.branchCount - oldBehavior.branchCount;
    if (branchDelta !== 0) {
      changes.push({
        category: "LOGIC_CHANGED",
        risk: "MEDIUM",
        location: loc,
        description: `\`${name}\` ${branchDelta > 0 ? "added" : "removed"} ${Math.abs(branchDelta)} conditional branch(es)`,
        before: `${oldBehavior.branchCount} branches`,
        after: `${newBehavior.branchCount} branches`,
      });
    }

    // 7. Timeout values changed (CONFIG / RISK_ADDED)
    const oldTimeouts = oldBehavior.timeoutValues;
    const newTimeouts = newBehavior.timeoutValues;
    if (oldTimeouts.length > 0 && newTimeouts.length > 0) {
      oldTimeouts.forEach((oldVal, i) => {
        const newVal = newTimeouts[i];
        if (newVal !== undefined && oldVal !== newVal) {
          const cat: ChangeCategory = newVal < oldVal ? "RISK_ADDED" : "CONFIG";
          const risk: RiskLevel = newVal < oldVal ? "HIGH" : "MEDIUM";
          changes.push({
            category: cat,
            risk,
            location: loc,
            description: `\`${name}\` timeout ${newVal < oldVal ? "reduced" : "increased"}: ${oldVal}ms → ${newVal}ms${newVal < oldVal ? " (may cause premature failures)" : ""}`,
            before: `${oldVal}ms`,
            after: `${newVal}ms`,
          });
        }
      });
    }

    // 8. Throw count changed
    if (oldBehavior.throwCount > newBehavior.throwCount) {
      changes.push({
        category: "RISK_ADDED",
        risk: "MEDIUM",
        location: loc,
        description: `\`${name}\` removed ${oldBehavior.throwCount - newBehavior.throwCount} explicit throw(s) — error propagation changed`,
      });
    } else if (newBehavior.throwCount > oldBehavior.throwCount) {
      changes.push({
        category: "LOGIC_CHANGED",
        risk: "MEDIUM",
        location: loc,
        description: `\`${name}\` added ${newBehavior.throwCount - oldBehavior.throwCount} explicit throw(s)`,
      });
    }

    // 9. Async changed
    if (oldBehavior.sig.isAsync !== newBehavior.sig.isAsync) {
      changes.push({
        category: "API_CHANGED",
        risk: "HIGH",
        location: loc,
        description: `\`${name}\` ${newBehavior.sig.isAsync ? "became async" : "removed async"} — callers may break`,
        before: oldBehavior.sig.isAsync ? "async" : "sync",
        after: newBehavior.sig.isAsync ? "async" : "sync",
      });
    }

    // 10. Return type changed
    if (
      normalize(oldBehavior.sig.returnType) !== normalize(newBehavior.sig.returnType) &&
      oldBehavior.sig.returnType !== "unknown" &&
      newBehavior.sig.returnType !== "unknown"
    ) {
      changes.push({
        category: "API_CHANGED",
        risk: "HIGH",
        location: loc,
        description: `\`${name}\` return type changed`,
        before: oldBehavior.sig.returnType,
        after: newBehavior.sig.returnType,
      });
    }
  }

  // Functions removed entirely
  for (const [name, oldBehavior] of oldFns) {
    if (!newFns.has(name)) {
      changes.push({
        category: "DEAD_CODE",
        risk: "NONE",
        location: `${name} @ ${patch.file}:${oldBehavior.sig.startLine}`,
        description: `Function \`${name}\` removed`,
      });
    }
  }

  // Import changes
  const addedImports = [...newImports].filter((i) => !oldImports.has(i));
  const removedImports = [...oldImports].filter((i) => !newImports.has(i));

  if (addedImports.length > 0) {
    changes.push({
      category: "DEPENDENCY",
      risk: "LOW",
      location: patch.file,
      description: `Added ${addedImports.length} import(s): ${addedImports.slice(0, 3).join(", ")}`,
      after: addedImports.join(", "),
    });
  }

  if (removedImports.length > 0) {
    changes.push({
      category: "DEPENDENCY",
      risk: "MEDIUM",
      location: patch.file,
      description: `Removed ${removedImports.length} import(s): ${removedImports.slice(0, 3).join(", ")} — verify no callers remain`,
      before: removedImports.join(", "),
    });
  }

  // Config constant changes
  for (const [key, newVal] of newConsts) {
    const oldVal = oldConsts.get(key);
    if (oldVal && oldVal !== newVal) {
      // Only flag if it looks like a config value (number, string, boolean)
      if (/^\d+$/.test(newVal.trim()) || /^["']/.test(newVal.trim()) || newVal === "true" || newVal === "false") {
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
  }

  return changes;
}

export function computeOverallRisk(changes: SemanticChange[]): RiskLevel {
  if (changes.some((c) => c.risk === "HIGH")) return "HIGH";
  if (changes.some((c) => c.risk === "MEDIUM")) return "MEDIUM";
  if (changes.some((c) => c.risk === "LOW")) return "LOW";
  return "NONE";
}
