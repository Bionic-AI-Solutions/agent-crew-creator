/**
 * Regression tests for finding #22 (medium): the webhook SSRF guard only
 * checked IPv4 (resolve4) and used loose prefix matching. isPrivateIp closes
 * the IPv6 hole and tightens the ranges.
 *
 * Run: npx tsx --test tests/ip-guard.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { isPrivateIp } from "../server/services/ipGuard.ts";

test("blocks IPv4 private / loopback / metadata / CGNAT ranges", () => {
  for (const ip of ["10.1.2.3", "127.0.0.1", "192.168.0.5", "172.16.0.1", "172.31.255.1",
                     "169.254.169.254", "0.0.0.0", "100.64.0.1"]) {
    assert.equal(isPrivateIp(ip), true, `${ip} should be private`);
  }
});

test("allows genuine public IPv4", () => {
  for (const ip of ["8.8.8.8", "1.1.1.1", "172.32.0.1", "172.15.0.1", "93.184.216.34"]) {
    assert.equal(isPrivateIp(ip), false, `${ip} should be public`);
  }
});

test("blocks IPv6 loopback, link-local, ULA (the AAAA hole)", () => {
  for (const ip of ["::1", "::", "fe80::1", "fd00::1", "fc00::1", "::ffff:192.168.1.1"]) {
    assert.equal(isPrivateIp(ip), true, `${ip} should be private`);
  }
});

test("allows public IPv6 and IPv4-mapped public", () => {
  assert.equal(isPrivateIp("2606:4700:4700::1111"), false);
  assert.equal(isPrivateIp("::ffff:8.8.8.8"), false);
});
