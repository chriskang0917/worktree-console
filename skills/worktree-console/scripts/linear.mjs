#!/usr/bin/env node
// Reads Linear straight from its API, with the key kept in the macOS keychain: the key never reaches argv, stdout or stderr.
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

export const SERVICE = "worktree-console-linear";
export const SETUP = `security add-generic-password -U -s ${SERVICE} -a "$USER" -w`;
const API = () => process.env.LINEAR_API_URL || "https://api.linear.app/graphql";

const ISSUE = `query Issue($id: String!) {
  issue(id: $id) {
    identifier title description url branchName priorityLabel
    state { name type }
    assignee { name }
    labels { nodes { name } }
    cycle { number name }
    project { name }
    parent { identifier title branchName }
    children { nodes { identifier title state { name } } }
  }
}`;

const TODO = `query Todo {
  viewer {
    assignedIssues(first: 250, filter: { state: { type: { eq: "unstarted" } } }) {
      nodes { identifier title cycle { number name } labels { nodes { name } } state { name type } }
    }
  }
}`;

export class LinearError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function apiKey() {
  const account = process.env.USER || os.userInfo().username;
  const res = spawnSync(process.env.SECURITY_BIN || "security", ["find-generic-password", "-s", SERVICE, "-a", account, "-w"], { encoding: "utf8" });
  const key = res.status === 0 ? (res.stdout || "").trim() : "";
  if (!key) throw new LinearError("linear_key_missing", `鑰匙圈裡沒有 Linear API key（service ${SERVICE}）`);
  return key;
}

async function graphql(query, variables = {}) {
  const key = apiKey();
  let res;
  try {
    res = await fetch(API(), { method: "POST", headers: { "Content-Type": "application/json", Authorization: key }, body: JSON.stringify({ query, variables }) });
  } catch (error) {
    throw new LinearError("linear_unreachable", `連不上 Linear API：${error.cause?.code ?? error.message}`);
  }
  if (res.status === 401 || res.status === 403) throw new LinearError("linear_key_invalid", `Linear 拒絕這把 API key（HTTP ${res.status}）`);
  let body;
  try {
    body = await res.json();
  } catch {
    throw new LinearError("linear_bad_response", `Linear API 回應看不懂（HTTP ${res.status}）`);
  }
  if (body.errors?.length) {
    const auth = body.errors.some((e) => e.extensions?.code === "AUTHENTICATION_ERROR");
    const missing = body.errors.some((e) => /not found|Entity not found/i.test(e.message ?? ""));
    if (auth) throw new LinearError("linear_key_invalid", "Linear 拒絕這把 API key");
    if (missing) throw new LinearError("linear_issue_not_found", "Linear 找不到這張票");
    throw new LinearError("linear_error", `Linear API 錯誤：${body.errors.map((e) => e.message).join("；")}`);
  }
  return body.data;
}

const nodes = (x) => x?.nodes ?? [];

export async function issue(id) {
  const data = await graphql(ISSUE, { id: id.toUpperCase() });
  const i = data?.issue;
  if (!i) throw new LinearError("linear_issue_not_found", `Linear 找不到 ${id}`);
  return { ...i, labels: nodes(i.labels), children: nodes(i.children) };
}

// Assigned to me, not started, in some cycle: the same set Orca's `linear list-issues --state unstarted` gave the console.
export async function todo() {
  const data = await graphql(TODO);
  return nodes(data?.viewer?.assignedIssues)
    .filter((i) => i.cycle)
    .map((i) => ({ ...i, labels: nodes(i.labels) }));
}

function issueLines(i) {
  return [
    `${i.identifier} ${i.title}`,
    `狀態：${i.state?.name ?? "—"}`,
    `branch：${i.branchName ?? "—"}`,
    `母票：${i.parent ? `${i.parent.identifier} ${i.parent.title}（branch ${i.parent.branchName ?? "—"}）` : "—"}`,
    `子票：${i.children.length > 0 ? i.children.map((c) => `${c.identifier} ${c.title}`).join("；") : "—"}`,
    `標籤：${i.labels.map((l) => l.name).join("、") || "—"}`,
    `cycle：${i.cycle ? i.cycle.name || `#${i.cycle.number}` : "—"}`,
    `url：${i.url ?? "—"}`,
    "",
    i.description?.trim() || "（沒有描述）",
  ];
}

function todoLines(list) {
  if (list.length === 0) return ["沒有待開工的票"];
  return ["| 票號 | 標題 | 狀態 |", "| --- | --- | --- |", ...list.map((i) => `| ${i.identifier} | ${i.title.replace(/\|/g, "\\|")} | ${i.state?.name ?? "—"} |`)];
}

// Puts the setup command on the clipboard; the user runs it in their own terminal, where the key is typed unseen.
function copySetup() {
  const res = spawnSync(process.env.PBCOPY_BIN || "pbcopy", [], { input: SETUP, encoding: "utf8" });
  return res.status === 0;
}

const USAGE = "用法：linear.mjs issue <票號> [--json]｜linear.mjs todo [--json]";

async function main(argv) {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { json: { type: "boolean", default: false } } });
  const [command, id] = positionals;
  const out = (lines) => console.log(lines.join("\n"));
  try {
    if (command === "issue" && id) {
      const i = await issue(id);
      return values.json ? console.log(JSON.stringify({ ok: true, issue: i })) : out(issueLines(i));
    }
    if (command === "todo") {
      const list = await todo();
      return values.json ? console.log(JSON.stringify({ ok: true, issues: list })) : out(todoLines(list));
    }
    console.log(USAGE);
    process.exitCode = 2;
  } catch (error) {
    if (!(error instanceof LinearError)) throw error;
    process.exitCode = 1;
    if (values.json) return console.log(JSON.stringify({ ok: false, error: { code: error.code, message: error.message } }));
    const key = ["linear_key_missing", "linear_key_invalid"].includes(error.code);
    if (!key) return console.log(`[linear] ${error.message}`);
    const copied = copySetup();
    out([
      `[linear] ${error.message}。`,
      copied ? "設定指令已用 pbcopy 複製到剪貼簿，請自己在終端機貼上執行，再依提示輸入 key（輸入時不會顯示）：" : "請自己在終端機執行下面這行，再依提示輸入 key（輸入時不會顯示）：",
      SETUP,
      "不要把 key 貼進 Claude 的對話。",
    ]);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main(process.argv.slice(2));
