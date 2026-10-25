import assert from "node:assert/strict";
import test from "node:test";
import { getPiLoginSourceIp } from "./login-source-ip.ts";

test("login IP display prefers a dedicated client header, then the first forwarded address", () => {
  assert.equal(getPiLoginSourceIp(new Headers({ "X-Ts-Client-IP": "203.0.113.1", "X-Real-IP": "203.0.113.2", "X-Forwarded-For": "203.0.113.3, 10.0.0.1" })), "203.0.113.1");
  assert.equal(getPiLoginSourceIp(new Headers({ "CF-Connecting-IP": "203.0.113.4", "X-Real-IP": "203.0.113.2" })), "203.0.113.4");
  assert.equal(getPiLoginSourceIp(new Headers({ "X-Real-IP": "203.0.113.2", "X-Forwarded-For": "203.0.113.3, 10.0.0.1" })), "203.0.113.2");
  assert.equal(getPiLoginSourceIp(new Headers({ "X-Forwarded-For": " 203.0.113.3 , 10.0.0.1" })), "203.0.113.3");
});

test("login IP display accepts IPv6 and simplifies IPv4-mapped connection addresses", () => {
  assert.equal(getPiLoginSourceIp(new Headers({ "X-Real-IP": "2001:db8::42" })), "2001:db8::42");
  assert.equal(getPiLoginSourceIp(new Headers({ "X-Forwarded-For": "::ffff:127.0.0.1" })), "127.0.0.1");
});

test("login IP display skips invalid values and never invents an address", () => {
  assert.equal(getPiLoginSourceIp(new Headers({ "X-Real-IP": "not an IP", "X-Forwarded-For": "203.0.113.8" })), "203.0.113.8");
  assert.equal(getPiLoginSourceIp(new Headers({ "X-Real-IP": "203.0.113.1:1234" })), "");
  assert.equal(getPiLoginSourceIp(new Headers()), "");
});
