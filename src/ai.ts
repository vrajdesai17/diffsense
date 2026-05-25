import Anthropic from "@anthropic-ai/sdk";
import { DiffReport } from "./types.js";

const HOSTED_API = "https://diffsense-api.vercel.app/api/narrate";

function buildSystemPrompt(): string {
  return `You are a senior software engineer reviewing a code diff.
You will receive a structured list of semantic changes detected by AST analysis.
Your job is to write a concise, opinionated behavioral summary — NOT a description of the diff itself.

Focus on:
- What the code will DO differently after this change
- Which changes introduce real risk (data loss, crashes, broken callers, security issues)
- Which changes are safe refactors vs silent behavior shifts
- Any patterns that suggest the diff may be incomplete (e.g. retry logic removed but no fallback added)

Format: plain prose, 3-6 sentences. Be direct. Mention specific function names. No bullet points.
If there are no high-risk changes, say so clearly.`;
}

export function buildUserPrompt(report: DiffReport): string {
  const lines: string[] = [
    `Diff: ${report.fromRef} → ${report.toRef}`,
    `Files changed: ${report.files.length}`,
    "",
  ];

  for (const file of report.files) {
    if (file.changes.length === 0) continue;
    lines.push(`## ${file.file} (overall risk: ${file.overallRisk})`);
    for (const change of file.changes) {
      const beforeAfter =
        change.before && change.after
          ? ` | before: "${change.before}" → after: "${change.after}"`
          : "";
      lines.push(`  [${change.category}] [${change.risk}] ${change.description}${beforeAfter}`);
    }
    lines.push("");
  }

  if (report.files.every((f) => f.changes.length === 0)) {
    lines.push("No semantic changes detected — only formatting/whitespace changes.");
  }

  return lines.join("\n");
}

async function narrativeViaHosted(prompt: string): Promise<string> {
  const res = await fetch(HOSTED_API, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt }),
    signal: AbortSignal.timeout(25000),
  });

  if (res.status === 429) {
    const { error } = await res.json() as { error: string };
    throw new Error(error);
  }

  if (!res.ok) {
    const { error } = await res.json() as { error: string };
    throw new Error(error ?? `Server error ${res.status}`);
  }

  const { narrative } = await res.json() as { narrative: string };
  return narrative;
}

async function narrativeViaLocalKey(prompt: string): Promise<string> {
  const client = new Anthropic();
  const response = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 512,
    system: [
      {
        type: "text",
        text: buildSystemPrompt(),
        cache_control: { type: "ephemeral" },
      },
    ],
    messages: [{ role: "user", content: prompt }],
  });
  const block = response.content[0];
  return block.type === "text" ? block.text : "(no narrative)";
}

export async function generateNarrative(report: DiffReport): Promise<string> {
  const prompt = buildUserPrompt(report);

  // Prefer local API key (developers / CI) — bypass the hosted endpoint
  if (process.env.ANTHROPIC_API_KEY) {
    return narrativeViaLocalKey(prompt);
  }

  return narrativeViaHosted(prompt);
}
