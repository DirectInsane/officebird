import { test } from "node:test";
import assert from "node:assert/strict";
import { domainOf, orgDomain, isAligned } from "../background/domain.js";

test("domainOf normalizes case, trailing dot and IDN", () => {
  assert.equal(domainOf("A@Mail.Example.COM."), "mail.example.com");
  assert.equal(domainOf("x@bücher.de"), "xn--bcher-kva.de");
});

test("domainOf returns null for unusable input", () => {
  assert.equal(domainOf("no-at-sign"), null);
  assert.equal(domainOf(""), null);
  assert.equal(domainOf("x@localhost"), null);
  assert.equal(domainOf(undefined), null);
});

test("orgDomain strips subdomains, honoring two-part suffixes", () => {
  assert.equal(orgDomain("mail.news.example.co.uk"), "example.co.uk");
  assert.equal(orgDomain("a.b.example.com"), "example.com");
  assert.equal(orgDomain("example.com"), "example.com");
});

test("isAligned: equal, parent or child domain only", () => {
  assert.equal(isAligned("mail.example.com", "example.com"), true);
  assert.equal(isAligned("example.com", "mail.example.com"), true);
  assert.equal(isAligned("example.net", "example.com"), false);
  assert.equal(isAligned("evil.com.sg", "bank.com.sg"), false);
  assert.equal(isAligned("notexample.com", "example.com"), false);
  assert.equal(isAligned("", "example.com"), false);
});

test("orgDomain recognizes ccTLD second-level suffixes not in the list", () => {
  assert.equal(orgDomain("x.bank.com.sg"), "bank.com.sg");
  assert.equal(orgDomain("a.b.co.kr"), "b.co.kr");
  assert.equal(orgDomain("news.example.de"), "example.de");
});

test("domainOf rejects URL syntax smuggled into the domain", () => {
  assert.equal(domainOf("x@evil.com/x.y"), null);
  assert.equal(domainOf("x@evil.com:8080"), null);
  assert.equal(domainOf("x@exa mple.com"), null);
});
