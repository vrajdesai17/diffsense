#!/usr/bin/env node
import { Command } from "commander";
import { getChangedFiles, getRepoRoot, resolveRefs } from "./git.js";
import { analyzeFileDiff, computeOverallRisk } from "./analyzer.js";
import { generateNarrative } from "./ai.js";
import { formatReport, formatJSON } from "./formatter.js";
import { DiffReport, RiskLevel } from "./types.js";
import chalk from "chalk";
import { version } from "../package.json";

const program = new Command();

program
  .name("diffsense")
  .description("Semantic diff analyzer — understand what code actually does differently")
  .version(version);

program
  .command("diff [from] [to]")
  .description("Analyze semantic changes between two git refs (default: HEAD~1 HEAD)")
  .option("--no-ai", "Skip AI narrative (faster, no API key needed)")
  .option("--json", "Output raw JSON instead of formatted report")
  .option("--risk <level>", "Only show changes at or above this risk level (HIGH|MEDIUM|LOW)")
  .option("--path <pattern>", "Only analyze files matching this glob pattern")
  .action(async (from = "HEAD~1", to = "HEAD", opts) => {
    try {
      const cwd = process.cwd();
      const repoRoot = await getRepoRoot(cwd).catch(() => cwd);

      process.stderr.write(chalk.gray(`  Resolving refs ${from} → ${to}...\n`));

      const { from: resolvedFrom, to: resolvedTo } = await resolveRefs(repoRoot, from, to);

      process.stderr.write(chalk.gray(`  Fetching changed files...\n`));
      const patches = await getChangedFiles(repoRoot, from, to);

      if (patches.length === 0) {
        console.log(chalk.yellow("  No TypeScript/JavaScript files changed between these refs."));
        process.exit(0);
      }

      process.stderr.write(chalk.gray(`  Analyzing ${patches.length} file(s)...\n`));

      const minRisk = (opts.risk as RiskLevel | undefined) ?? "NONE";
      const riskOrder: RiskLevel[] = ["NONE", "LOW", "MEDIUM", "HIGH"];
      const minRiskIndex = riskOrder.indexOf(minRisk);

      const riskSummary: Record<RiskLevel, number> = { HIGH: 0, MEDIUM: 0, LOW: 0, NONE: 0 };
      let totalChanges = 0;

      const fileDiffResults = patches.map((patch) => {
        const changes = analyzeFileDiff(patch);
        const filtered =
          minRisk === "NONE"
            ? changes
            : changes.filter((c) => riskOrder.indexOf(c.risk) >= minRiskIndex);

        for (const c of filtered) {
          riskSummary[c.risk]++;
          totalChanges++;
        }

        return {
          file: patch.file,
          added: patch.added,
          removed: patch.removed,
          changes: filtered,
          overallRisk: computeOverallRisk(filtered),
          rawPatch: patch.patch,
        };
      });

      const report: DiffReport = {
        fromRef: from,
        toRef: to,
        files: fileDiffResults,
        totalChanges,
        riskSummary,
      };

      if (opts.ai !== false) {
        const apiKey = process.env.ANTHROPIC_API_KEY;
        if (!apiKey) {
          process.stderr.write(chalk.yellow("  ANTHROPIC_API_KEY not set — skipping AI narrative (use --no-ai to suppress this warning)\n"));
        } else {
          process.stderr.write(chalk.gray("  Generating AI behavioral narrative...\n"));
          try {
            report.aiNarrative = await generateNarrative(report);
          } catch (err) {
            process.stderr.write(chalk.yellow(`  AI narrative failed: ${(err as Error).message}\n`));
          }
        }
      }

      process.stderr.write("\n");

      if (opts.json) {
        // Remove rawPatch from JSON output to keep it clean
        const cleanReport = {
          ...report,
          files: report.files.map(({ rawPatch: _, ...rest }) => rest),
        };
        console.log(formatJSON(cleanReport));
      } else {
        console.log(formatReport(report));
      }

      // Exit with non-zero if HIGH risk changes found
      if (riskSummary.HIGH > 0) {
        process.exit(1);
      }
    } catch (err) {
      const error = err as Error;
      if (error.message.includes("not a git repository")) {
        console.error(chalk.red("  Error: not a git repository. Run diffsense from within a git repo."));
      } else if (error.message.includes("unknown revision")) {
        console.error(chalk.red(`  Error: could not resolve refs. Make sure '${from}' and '${to}' exist.`));
      } else {
        console.error(chalk.red(`  Error: ${error.message}`));
      }
      process.exit(2);
    }
  });

program
  .command("explain <file>")
  .description("Explain what a single TypeScript/JavaScript file does (no git needed)")
  .action(async (file: string) => {
    const fs = await import("fs/promises");
    try {
      const content = await fs.readFile(file, "utf-8");
      const { Project } = await import("ts-morph");
      const project = new Project({ useInMemoryFileSystem: true, skipAddingFilesFromTsConfig: true });
      const src = project.createSourceFile(file, content);

      const fns = src.getFunctions();
      const classes = src.getClasses();

      console.log(chalk.bold(`\n  ${file}`));
      console.log(chalk.gray(`  ${fns.length} functions · ${classes.length} classes\n`));

      fns.forEach((fn) => {
        const name = fn.getName() ?? "(anonymous)";
        const params = fn.getParameters().map((p) => p.getName()).join(", ");
        const ret = fn.getReturnType().getText();
        const isAsync = fn.isAsync() ? chalk.cyan("async ") : "";
        console.log(`  ${isAsync}${chalk.bold(name)}(${chalk.gray(params)}) → ${chalk.yellow(ret)}`);
      });

      classes.forEach((cls) => {
        console.log(`\n  ${chalk.bold.blue("class")} ${chalk.bold(cls.getName() ?? "Anonymous")}`);
        cls.getMethods().forEach((m) => {
          const params = m.getParameters().map((p) => p.getName()).join(", ");
          const ret = m.getReturnType().getText();
          console.log(`    ${chalk.bold(m.getName())}(${chalk.gray(params)}) → ${chalk.yellow(ret)}`);
        });
      });

      console.log("");
    } catch (err) {
      console.error(chalk.red(`  Error reading ${file}: ${(err as Error).message}`));
      process.exit(1);
    }
  });

program.parse();
