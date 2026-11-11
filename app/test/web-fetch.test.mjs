import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_ALLOWED_HOSTS,
  assertUrlAllowed,
  isHostAllowed,
  isPrivateAddress,
} from "../dist/main/tools/web-fetch.js";

const hosts = DEFAULT_ALLOWED_HOSTS;

test("allowlist matches hosts and subdomains only", () => {
  assert.ok(isHostAllowed("wowhead.com", hosts));
  assert.ok(isHostAllowed("www.wowhead.com", hosts));
  assert.ok(isHostAllowed("WWW.WOWHEAD.COM.", hosts));
  assert.ok(!isHostAllowed("evilwowhead.com", hosts));
  assert.ok(!isHostAllowed("wowhead.com.evil.example", hosts));
  assert.ok(!isHostAllowed("attacker.com", hosts));
  assert.ok(!isHostAllowed("localhost", hosts));
});

test("private, loopback, link-local and tailnet addresses are private", () => {
  for (const ip of [
    "127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1",
    "169.254.169.254", "100.64.0.1", "100.122.147.57", "0.0.0.0", "224.0.0.1",
    "::1", "::", "fe80::1", "fd00::1", "fc00::1", "::ffff:127.0.0.1", "::ffff:7f00:1",
    "not-an-ip",
  ]) {
    assert.ok(isPrivateAddress(ip), ip);
  }
  for (const ip of ["8.8.8.8", "1.1.1.1", "172.32.0.1", "100.128.0.1", "2606:4700::1111"]) {
    assert.ok(!isPrivateAddress(ip), ip);
  }
});

test("URL validation rejects everything except https pages on allowed hosts", async () => {
  const bad = [
    "http://www.wowhead.com/",                 // not https
    "https://attacker.com/?q=secret",          // not allowed
    "https://localhost/",                      // local
    "https://127.0.0.1/",                      // IP literal
    "https://[::1]/",                          // IPv6 literal
    "https://192.168.1.1/admin",               // LAN
    "https://user:pw@www.wowhead.com/",        // credentials
    "https://www.wowhead.com:8443/",           // odd port
    "https://www.wowhead.com.evil.example/",   // suffix trick
    "file:///etc/passwd",
    "javascript:alert(1)",
    "not a url",
  ];
  for (const url of bad) {
    await assert.rejects(assertUrlAllowed(url, hosts), undefined, url);
  }
});

test("an allowed host that resolves to a private address is rejected", async () => {
  // localhost resolves to loopback; allowing it by name must still fail the address check.
  await assert.rejects(
    assertUrlAllowed("https://localhost/", ["localhost"]),
    /non-public/,
  );
});
