import "./env.js";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isTrustedWebOrigin, trustedWebOrigins } from "../src/config.js";

describe("trustedWebOrigins", () => {
  it("includes apex and www for production hostnames", () => {
    const set = trustedWebOrigins("https://interviewveil.com");
    assert.ok(set.has("https://interviewveil.com"));
    assert.ok(set.has("https://www.interviewveil.com"));
  });

  it("includes apex when WEB_URL is www", () => {
    const set = trustedWebOrigins("https://www.interviewveil.com");
    assert.ok(set.has("https://www.interviewveil.com"));
    assert.ok(set.has("https://interviewveil.com"));
  });

  it("does not invent www for localhost", () => {
    const set = trustedWebOrigins("http://localhost:5173");
    assert.deepEqual([...set], ["http://localhost:5173"]);
  });
});

describe("isTrustedWebOrigin", () => {
  it("accepts www when WEB_URL is apex (test env)", () => {
    assert.equal(isTrustedWebOrigin("http://localhost:5173"), true);
    assert.equal(isTrustedWebOrigin("https://www.interviewveil.com"), false);
  });
});
