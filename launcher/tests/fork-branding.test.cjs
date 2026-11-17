const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");

const read = (...segments) => fs.readFileSync(path.join(root, ...segments), "utf8");

test("the launcher never points updates at the upstream project", () => {
  const update = read("electron", "update.cjs");
  assert.match(update, /REPOSITORY = "BenjiThatFoxGuy\/hermes-chatgpt-web"/);
  assert.doesNotMatch(update, /miuuyy\/codex-chatgpt-web/);
});

test("a fork with no published release reads as up to date instead of an error", () => {
  const update = read("electron", "update.cjs");
  assert.match(update, /error\.statusCode = response\.statusCode/);
  assert.match(update, /error\.statusCode === 404\) return null/);
  assert.match(update, /if \(!release\) return transition\(\{ status: "up-to-date" \}\)/);
});

test("OG product branding is gone from the launcher UI copy", () => {
  const i18n = read("src", "i18n.ts");
  assert.doesNotMatch(i18n, /Codex Web GPT/);
  for (const removed of ["supportTitle", "supportBody", "star:", "starred:", "follow:", "followed:", "finishWelcome"]) {
    assert.doesNotMatch(i18n, new RegExp(removed.replace(/[$]/g, "\\$&")), `i18n still has ${removed}`);
  }
});

test("the forced social onboarding gate is gone", () => {
  const app = read("src", "App.tsx");
  for (const removed of ["openSocial", "githubOpened", "xOpened", "setStage(\"support\")"]) {
    assert.doesNotMatch(app, new RegExp(removed), `App.tsx still references ${removed}`);
  }
  const types = read("src", "types.ts");
  assert.doesNotMatch(types, /githubOpened|xOpened/);
  const preload = read("electron", "preload.cjs");
  assert.doesNotMatch(preload, /open-social/);
});
