import chalk, { ChalkInstance } from "chalk";
import { DiffReport, FileDiffResult, RiskLevel, SemanticChange, ChangeCategory } from "./types.js";

const RISK_COLOR: Record<RiskLevel, ChalkInstance> = {
  HIGH: chalk.bold.red,
  MEDIUM: chalk.bold.yellow,
  LOW: chalk.cyan,
  NONE: chalk.gray,
};

const CATEGORY_ICON: Record<ChangeCategory, string> = {
  RISK_ADDED: "⚠",
  RISK_REMOVED: "✓",
  API_CHANGED: "⬡",
  LOGIC_CHANGED: "~",
  BEHAVIOR_NEW: "+",
  REFACTOR: "↺",
  DEAD_CODE: "✗",
  DEPENDENCY: "⊞",
  CONFIG: "⚙",
};

function riskBadge(risk: RiskLevel): string {
  const color = RISK_COLOR[risk];
  return color(`[${risk}]`);
}

function categoryLabel(cat: ChangeCategory, risk: RiskLevel): string {
  const icon = CATEGORY_ICON[cat];
  const color = RISK_COLOR[risk];
  return color(`${icon} ${cat}`);
}

function pad(s: string, width: number): string {
  return s + " ".repeat(Math.max(0, width - s.length));
}

export function formatReport(report: DiffReport): string {
  const lines: string[] = [];

  // Header
  lines.push("");
  lines.push(chalk.bold.white("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"));
  lines.push(chalk.bold.white("  diffsense") + chalk.gray("  semantic diff analyzer"));
  lines.push(chalk.bold.white("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"));
  lines.push(`  ${chalk.gray("from")} ${chalk.white(report.fromRef)}  ${chalk.gray("→")}  ${chalk.white(report.toRef)}`);
  lines.push(`  ${chalk.gray("files")} ${chalk.white(String(report.files.length))}   ${chalk.gray("changes")} ${chalk.white(String(report.totalChanges))}`);

  // Risk summary
  const { HIGH, MEDIUM, LOW, NONE } = report.riskSummary;
  const riskParts = [
    HIGH > 0 ? chalk.bold.red(`${HIGH} HIGH`) : null,
    MEDIUM > 0 ? chalk.bold.yellow(`${MEDIUM} MEDIUM`) : null,
    LOW > 0 ? chalk.cyan(`${LOW} LOW`) : null,
    NONE > 0 ? chalk.gray(`${NONE} NONE`) : null,
  ].filter(Boolean);
  lines.push(`  ${chalk.gray("risk")}  ${riskParts.join(chalk.gray("  ·  "))}`);
  lines.push(chalk.bold.white("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"));
  lines.push("");

  // Per-file sections
  for (const file of report.files) {
    if (file.changes.length === 0) continue;

    const fileRiskColor = RISK_COLOR[file.overallRisk];
    const stats = chalk.gray(`+${file.added} -${file.removed}`);
    lines.push(`  ${fileRiskColor("▶")} ${chalk.bold(file.file)}  ${stats}  ${fileRiskColor(file.overallRisk)}`);
    lines.push("");

    for (const change of file.changes) {
      const icon = CATEGORY_ICON[change.category];
      const color = RISK_COLOR[change.risk];
      const label = pad(change.category, 14);
      lines.push(`    ${color(icon)}  ${color(label)}  ${change.description}`);

      if (change.before && change.after) {
        lines.push(`       ${chalk.gray("before:")} ${chalk.red(change.before)}`);
        lines.push(`       ${chalk.gray("after: ")} ${chalk.green(change.after)}`);
      } else if (change.after) {
        lines.push(`       ${chalk.gray("after: ")} ${chalk.green(change.after)}`);
      } else if (change.before) {
        lines.push(`       ${chalk.gray("before:")} ${chalk.red(change.before)}`);
      }
    }

    lines.push("");
  }

  // AI narrative
  if (report.aiNarrative) {
    lines.push(chalk.bold.white("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"));
    lines.push(`  ${chalk.bold.white("AI Behavioral Summary")}`);
    lines.push(chalk.bold.white("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"));
    lines.push("");

    const wrapped = wrapText(report.aiNarrative, 74);
    for (const line of wrapped) {
      lines.push(`  ${chalk.white(line)}`);
    }
    lines.push("");
  }

  if (report.files.every((f) => f.changes.length === 0)) {
    lines.push(`  ${chalk.gray("No semantic changes detected — only formatting or whitespace changes.")}`);
    lines.push("");
  }

  return lines.join("\n");
}

export function formatJSON(report: DiffReport): string {
  return JSON.stringify(report, null, 2);
}

function wrapText(text: string, width: number): string[] {
  const lines: string[] = [];
  const paragraphs = text.split("\n");
  for (const para of paragraphs) {
    if (para.length <= width) {
      lines.push(para);
      continue;
    }
    const words = para.split(" ");
    let current = "";
    for (const word of words) {
      if (current.length + word.length + 1 > width) {
        lines.push(current);
        current = word;
      } else {
        current = current ? `${current} ${word}` : word;
      }
    }
    if (current) lines.push(current);
  }
  return lines;
}
