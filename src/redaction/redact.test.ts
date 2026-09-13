import { describe, expect, it } from "vitest";
import { redact, redactAll, restorePlaceholders } from "./redact";

describe("redact", () => {
  it("redacts an email address", () => {
    const r = redact("email john@acme.com today");
    expect(r.text).toBe("email [EMAIL_1] today");
    expect(r.replacements).toEqual([{ placeholder: "[EMAIL_1]", original: "john@acme.com", type: "email" }]);
  });

  it("redacts phone numbers in common formats", () => {
    expect(redact("call 425-555-0199").text).toBe("call [PHONE_1]");
    expect(redact("call +1 (425) 555-0199").text).toBe("call [PHONE_1]");
    expect(redact("call 425.555.0199 now").text).toBe("call [PHONE_1] now");
  });

  it("redacts SSNs and rejects invalid areas", () => {
    expect(redact("ssn 123-45-6789").text).toBe("ssn [SSN_1]");
    expect(redact("ssn 000-12-3456").replacements).toHaveLength(0);
    expect(redact("ssn 666-12-3456").replacements).toHaveLength(0);
    expect(redact("ssn 900-12-3456").replacements).toHaveLength(0);
  });

  it("redacts credit cards passing Luhn and ignores others", () => {
    const r = redact("card 4111 1111 1111 1111 please");
    expect(r.text).toBe("card [CARD_1] please");
    expect(r.replacements[0]).toMatchObject({ type: "card" });
    expect(redact("card 1234 5678 9012 3456").replacements).toHaveLength(0);
  });

  it("redacts URLs", () => {
    const r = redact("see https://example.com/a?b=c, thanks");
    expect(r.text).toBe("see [URL_1], thanks");
  });

  it("redacts IPv4 and full IPv6 addresses", () => {
    expect(redact("host 192.168.1.1 down").text).toBe("host [IP_1] down");
    expect(redact("host 2001:0db8:85a3:0000:0000:8a2e:0370:7334 x").text).toContain("[IP_1]");
  });

  it("redacts API keys and labeled secrets", () => {
    expect(redact("key sk-ant-abcdefgh1234").text).toBe("key [SECRET_1]");
    expect(redact("token ghp_abcdefgh12345678").text).toBe("token [SECRET_1]");
    expect(redact("id AKIAIOSFODNN7EXAMPLE").text).toBe("id [SECRET_1]");
    expect(redact("api_key: abcdef1234567890").text).toBe("api_key: [SECRET_1]");
  });

  it("redacts JWTs", () => {
    const jwt =
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
    const r = redact(`bearer ${jwt}`);
    expect(r.text).toBe("bearer [SECRET_1]");
  });

  it("redacts UUIDs", () => {
    const r = redact("id 123e4567-e89b-12d3-a456-426614174000 ok");
    expect(r.text).toBe("id [UUID_1] ok");
  });

  it("maps identical values to the same placeholder", () => {
    const r = redact("Email john@acme.com. Follow up with john@acme.com.");
    expect(r.text).toBe("Email [EMAIL_1]. Follow up with [EMAIL_1].");
    expect(r.replacements).toHaveLength(1);
  });

  it("numbers multiple values of the same type deterministically", () => {
    const r = redact("a@x.com then b@y.org");
    expect(r.text).toBe("[EMAIL_1] then [EMAIL_2]");
  });

  it("handles multiple sensitive values of different types", () => {
    const r = redact("Hi Sarah, email john@acme.com or call 425-555-0199.");
    expect(r.text).toBe("Hi Sarah, email [EMAIL_1] or call [PHONE_1].");
    expect(r.replacements.map((x) => x.type)).toEqual(["email", "phone"]);
  });

  it("keeps surrounding punctuation outside placeholders", () => {
    expect(redact("(john@acme.com),").text).toBe("([EMAIL_1]),");
    expect(redact('"425-555-0199!"').text).toBe('"[PHONE_1]!"');
  });

  it("handles multiline text", () => {
    const r = redact("line one\njohn@acme.com\nline three 425-555-0199\n");
    expect(r.text).toContain("[EMAIL_1]");
    expect(r.text).toContain("[PHONE_1]");
    expect(r.text.split("\n")).toHaveLength(4);
  });

  it("leaves clean text untouched", () => {
    const r = redact("Just a normal sentence about lunch tomorrow.");
    expect(r.text).toBe("Just a normal sentence about lunch tomorrow.");
    expect(r.replacements).toHaveLength(0);
  });

  it("resists false positives in ordinary text", () => {
    const cases = [
      "I have 2 apples and 300 dollars",
      "meeting on 2026-09-06 at 12:30",
      "version 2.5.1 was released yesterday",
      "my token of appreciation means a lot",
      "passwords must be strong and unique",
      "Order 12345 shipped",
      "pi is approximately 3.14159",
      "call me maybe later",
    ];
    for (const text of cases) {
      expect(redact(text).replacements, text).toHaveLength(0);
    }
  });

  it("preserves Unicode text while redacting", () => {
    const r = redact("Café naïve — email josé@example.com, 聯繫我");
    expect(r.text).toBe("Café naïve — email [EMAIL_1], 聯繫我");
    expect(r.replacements[0]?.original).toBe("josé@example.com");
  });

  it("prefers URL over an email inside it", () => {
    const r = redact("see https://example.com/@john for details");
    expect(r.text).toBe("see [URL_1] for details");
    expect(r.replacements).toHaveLength(1);
  });
});

describe("redactAll", () => {
  it("shares numbering across texts", () => {
    const { texts, replacements } = redactAll(["john@acme.com", "call john@acme.com"]);
    expect(texts).toEqual(["[EMAIL_1]", "call [EMAIL_1]"]);
    expect(replacements).toHaveLength(1);
  });

  it("keeps placeholders unique across texts", () => {
    const { texts } = redactAll(["a@x.com", "b@y.org"]);
    expect(texts).toEqual(["[EMAIL_1]", "[EMAIL_2]"]);
  });
});

describe("restorePlaceholders", () => {
  it("restores exact placeholders", () => {
    const r = restorePlaceholders("Contact [EMAIL_1] or [PHONE_1].", [
      { placeholder: "[EMAIL_1]", original: "john@acme.com", type: "email" },
      { placeholder: "[PHONE_1]", original: "425-555-0199", type: "phone" },
    ]);
    expect(r.text).toBe("Contact john@acme.com or 425-555-0199.");
    expect(r.complete).toBe(true);
    expect(r.missing).toEqual([]);
    expect(r.unexpected).toEqual([]);
  });

  it("reports a missing placeholder without inserting secrets", () => {
    const r = restorePlaceholders("Contact us.", [
      { placeholder: "[EMAIL_1]", original: "john@acme.com", type: "email" },
    ]);
    expect(r.text).toBe("Contact us.");
    expect(r.text).not.toContain("john@acme.com");
    expect(r.complete).toBe(false);
    expect(r.missing).toEqual(["[EMAIL_1]"]);
  });

  it("leaves renamed placeholders untouched", () => {
    const r = restorePlaceholders("Contact [EMAIL].", [
      { placeholder: "[EMAIL_1]", original: "john@acme.com", type: "email" },
    ]);
    expect(r.text).toBe("Contact [EMAIL].");
    expect(r.text).not.toContain("john@acme.com");
    expect(r.complete).toBe(false);
  });

  it("leaves recased placeholders untouched", () => {
    const r = restorePlaceholders("Contact [email_1].", [
      { placeholder: "[EMAIL_1]", original: "john@acme.com", type: "email" },
    ]);
    expect(r.text).not.toContain("john@acme.com");
    expect(r.complete).toBe(false);
  });

  it("reports invented placeholders without resolving them", () => {
    const r = restorePlaceholders("Contact [EMAIL_1] and [SSN_9].", [
      { placeholder: "[EMAIL_1]", original: "john@acme.com", type: "email" },
    ]);
    expect(r.text).toBe("Contact john@acme.com and [SSN_9].");
    expect(r.complete).toBe(false);
    expect(r.unexpected).toEqual(["[SSN_9]"]);
    expect(r.missing).toEqual([]);
  });
});

describe("mention redaction", () => {
  it("redacts a tagged username", () => {
    const r = redact("@Byte - status update?");
    expect(r.text).toBe("[MENTION_1] - status update?");
    expect(r.replacements).toEqual([{ placeholder: "[MENTION_1]", original: "@Byte", type: "mention" }]);
  });

  it("shares one placeholder for repeated mentions", () => {
    const r = redact("@Byte ping @Byte again");
    expect(r.text).toBe("[MENTION_1] ping [MENTION_1] again");
    expect(r.replacements).toHaveLength(1);
  });

  it("numbers distinct mentions deterministically", () => {
    const r = redact("@Byte and @Ada, standup?");
    expect(r.text).toBe("[MENTION_1] and [MENTION_2], standup?");
  });

  it("keeps trailing punctuation outside the placeholder", () => {
    expect(redact("ping @Byte!").text).toBe("ping [MENTION_1]!");
  });

  it("never steals the domain half of an email", () => {
    const r = redact("mail john@acme.com and @Byte");
    expect(r.text).toBe("mail [EMAIL_1] and [MENTION_1]");
  });

  it("ignores bare @ and non-handle uses", () => {
    for (const text of ["email me @ noon", "@ 5pm sharp", "score 10 @ home", "a @ b"]) {
      expect(redact(text).replacements, text).toHaveLength(0);
    }
  });

  it("restores mentions in rewritten output", () => {
    const r = restorePlaceholders("[MENTION_1], could you share a status update?", [
      { placeholder: "[MENTION_1]", original: "@Byte", type: "mention" },
    ]);
    expect(r.text).toBe("@Byte, could you share a status update?");
    expect(r.complete).toBe(true);
  });
});

describe("detectMentionLabels", () => {
  it("returns labels in order of appearance", async () => {
    const { detectMentionLabels } = await import("./detectors");
    expect(detectMentionLabels("@Byte - update? ping @Ada")).toEqual(["@Byte", "@Ada"]);
  });

  it("returns duplicates for repeated mentions", async () => {
    const { detectMentionLabels } = await import("./detectors");
    expect(detectMentionLabels("@Byte ping @Byte")).toEqual(["@Byte", "@Byte"]);
  });

  it("returns empty for ordinary text", async () => {
    const { detectMentionLabels } = await import("./detectors");
    expect(detectMentionLabels("no mentions here")).toEqual([]);
  });
});
