const test = require("node:test");
const assert = require("node:assert");
const { slugify } = require("../slugify.js");

test("lowercases and joins words with a dash", () => assert.strictEqual(slugify("Hello World"), "hello-world"));
test("trims and collapses repeated whitespace", () => assert.strictEqual(slugify("  Hello   World  "), "hello-world"));
test("strips accents and punctuation", () => assert.strictEqual(slugify("Crème Brûlée!"), "creme-brulee"));
test("collapses repeated separators", () => assert.strictEqual(slugify("a--b__c"), "a-b-c"));
test("drops symbols between words", () => assert.strictEqual(slugify("C++ & Rust"), "c-rust"));
test("no leading or trailing dashes", () => assert.strictEqual(slugify("---Already-Slug---"), "already-slug"));
test("empty string stays empty", () => assert.strictEqual(slugify(""), ""));
test("transliterates special letters (ß -> ss)", () => assert.strictEqual(slugify("Straße"), "strasse"));
test("transliterates ligatures and slashed letters", () => assert.strictEqual(slugify("Ærø & Østerbro"), "aero-osterbro"));
test("keeps digits and drops percent signs", () => assert.strictEqual(slugify("100% Pure Juice"), "100-pure-juice"));
