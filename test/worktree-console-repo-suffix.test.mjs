import "./fixtures/isolate-env.mjs";
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { decorate, repoSuffixes } from "../skills/worktree-console/scripts/lib.mjs";

let home;
before(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "wtc-suffix-"));
  process.env.WORKTREE_CONSOLE_HOME = home;
});
after(() => fs.rmSync(home, { recursive: true, force: true }));

const row = (repo, ticket, branch = `feat/${ticket.toLowerCase()}`) => ({
  path: `/wt/${repo}/${branch}`,
  repo,
  branch,
  ticket,
  isMain: false,
  unmanaged: false,
  displayName: branch,
  sessions: [{ n: null, paneKey: `${repo}-${ticket}`, status: { kind: "done", text: "" } }],
});
const labels = (rows) => decorate({ rows, keys: new Set(["SARA"]) }, { withStage: false }).rows.map((r) => r.label);

test("多 repo 同票：去掉相同開頭、frontend／backend 縮成 fe／be 接在票號後面，不再是 <repo>/<票號>", () => {
  fs.rmSync(path.join(home, "config.json"), { force: true });
  assert.deepEqual(labels([row("sara-v2-frontend", "SARA-7063"), row("sara-v2-backend", "SARA-7063")]), ["SARA-7063-fe", "SARA-7063-be"]);
  assert.deepEqual(labels([row("sara-v2-frontend", "SARA-1"), row("sara-v2-backend", "SARA-2")]), ["SARA-1", "SARA-2"], "不同票不加");
});

test("多 repo 同票：config.json 的 repoAbbreviations 優先；沒設定也縮不出常見字時用去掉相同開頭的 repo 名稱", () => {
  fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ repoAbbreviations: { "shop-web": "w" } }));
  assert.deepEqual(labels([row("shop-web", "SARA-9"), row("shop-worker", "SARA-9")]), ["SARA-9-w", "SARA-9-worker"]);
  fs.rmSync(path.join(home, "config.json"));
  assert.deepEqual([...repoSuffixes(["acme-admin-portal", "acme-billing"]).values()], ["admin-portal", "billing"]);
  assert.deepEqual([...repoSuffixes(["app", "api"]).values()], ["app", "api"], "沒有相同開頭就用整個 repo 名稱");
});

test("多 repo 同票：縮完兩邊一樣時退回完整 repo 名稱，不會出現兩個一樣的名稱", () => {
  fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ repoAbbreviations: { "one-api": "x", "two-api": "x" } }));
  assert.deepEqual(labels([row("one-api", "SARA-5"), row("two-api", "SARA-5")]), ["SARA-5-one-api", "SARA-5-two-api"]);
  fs.rmSync(path.join(home, "config.json"));
  assert.deepEqual([...repoSuffixes(["web-frontend", "app-frontend"]).values()], ["web-fe", "app-fe"]);
  assert.deepEqual([...repoSuffixes(["x-frontend", "x_frontend"]).values()], ["x-frontend", "x_frontend"], "縮完都是 fe 時用完整名稱");
});
