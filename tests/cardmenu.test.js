import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

// Classic script; the experiment runs it in a sandbox, so do the same.
const context = {};
vm.runInNewContext(readFileSync(new URL("../experiments/qol/cardmenu.js", import.meta.url), "utf8"), context);
const { place } = context.qolCardMenu;

// querySelector supports only ".a > .b" and ".a".
function node(className, children = []) {
  const el = {
    className,
    children: [],
    parentElement: null,
    moves: 0,
    get nextElementSibling() {
      const siblings = this.parentElement?.children ?? [];
      return siblings[siblings.indexOf(this) + 1] ?? null;
    },
    insertBefore(child, ref) {
      detach(child);
      this.children.splice(this.children.indexOf(ref), 0, child);
      child.parentElement = this;
      child.moves++;
    },
    append(child) {
      detach(child);
      this.children.push(child);
      child.parentElement = this;
      child.moves++;
    },
    querySelector(selector) {
      const [parent, own] = selector.includes(">") ? selector.split(">").map(s => s.trim().slice(1)) : [null, selector.slice(1)];
      const walk = e => e.children.flatMap(c => [c, ...walk(c)]);
      return walk(this).find(e => e.className.split(" ").includes(own) &&
        (!parent || e.parentElement.className.split(" ").includes(parent))) ?? null;
    },
  };
  for (const child of children) {
    el.children.push(child);
    child.parentElement = el;
  }
  return el;
}

function detach(child) {
  const siblings = child.parentElement?.children;
  if (siblings) {
    siblings.splice(siblings.indexOf(child), 1);
  }
}

// A thread card as Thunderbird builds it.
function card() {
  const more = node("button tree-button-more");
  const star = node("button-star tree-button-flag");
  const senderRow = node("thread-card-row", [node("sender"), node("date"), more]);
  const info = node("thread-card-icon-info", [node("attachment-icon"), node("button-spam"), star]);
  const dynamicRow = node("thread-card-dynamic-row", [node("thread-card-subject-container"), info]);
  return { root: node("card-container", [node("thread-card-column", [senderRow, dynamicRow])]), more, star, senderRow, info };
}

const names = el => el.children.map(c => c.className.split(" ")[0]);

test("the message menu goes right before the star, so the date ends the sender line", () => {
  const c = card();
  assert.equal(place(c.root, true), true);
  assert.deepEqual(names(c.senderRow), ["sender", "date"]);
  assert.deepEqual(names(c.info), ["attachment-icon", "button-spam", "button", "button-star"]);
});

test("placing it again moves nothing (cards are refilled on every scroll)", () => {
  const c = card();
  place(c.root, true);
  place(c.root, true);
  assert.equal(c.more.moves, 1);
});

test("it goes back to the end of the sender line, where Thunderbird has it", () => {
  const c = card();
  place(c.root, true);
  assert.equal(place(c.root, false), true);
  assert.deepEqual(names(c.senderRow), ["sender", "date", "button"]);
  assert.deepEqual(names(c.info), ["attachment-icon", "button-spam", "button-star"]);
  place(c.root, false);
  assert.equal(c.more.moves, 2, "already there: not moved");
});

test("a card without the menu or the star is left alone", () => {
  const c = card();
  detach(c.star);
  assert.equal(place(c.root, true), false);
  assert.deepEqual(names(c.senderRow), ["sender", "date", "button"]);
});
