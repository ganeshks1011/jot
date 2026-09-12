import { describe, expect, it } from "vitest";
import { isLoopbackHostname, isRelayUrlAllowed } from "./net";

describe("isRelayUrlAllowed", () => {
  it("allows https anywhere", () => {
    expect(isRelayUrlAllowed("https://api.openai.com/v1/chat/completions")).toBe(true);
    expect(isRelayUrlAllowed("https://wurkflo.app/api/ai/rewrite")).toBe(true);
    expect(isRelayUrlAllowed("https://anything.example:8443/x")).toBe(true);
  });

  it("allows plaintext http for loopback only", () => {
    expect(isRelayUrlAllowed("http://localhost:11434/v1/chat/completions")).toBe(true);
    expect(isRelayUrlAllowed("http://127.0.0.1:1234/v1/models")).toBe(true);
    expect(isRelayUrlAllowed("http://[::1]:11434/v1/models")).toBe(true);
    expect(isRelayUrlAllowed("http://192.168.1.10:11434/v1/chat/completions")).toBe(false);
    expect(isRelayUrlAllowed("http://keys.example/")).toBe(false);
  });

  it("rejects non-http schemes and garbage", () => {
    expect(isRelayUrlAllowed("ftp://files.example/x")).toBe(false);
    expect(isRelayUrlAllowed("file:///etc/passwd")).toBe(false);
    expect(isRelayUrlAllowed("data:text/plain,hi")).toBe(false);
    expect(isRelayUrlAllowed("javascript:alert(1)")).toBe(false);
    expect(isRelayUrlAllowed("not-a-url")).toBe(false);
    expect(isRelayUrlAllowed("")).toBe(false);
  });
});

describe("isLoopbackHostname", () => {
  it("matches loopback spellings only", () => {
    expect(isLoopbackHostname("localhost")).toBe(true);
    expect(isLoopbackHostname("127.0.0.1")).toBe(true);
    expect(isLoopbackHostname("::1")).toBe(true);
    expect(isLoopbackHostname("[::1]")).toBe(true);
    expect(isLoopbackHostname("localhost.example")).toBe(false);
    expect(isLoopbackHostname("example.com")).toBe(false);
  });
});
