import { describe, expect, it, vi } from "vitest";
import { copyDomHtml, copyHtml, copyText, type ContentNodeLike } from "./clipboard";

function doc(): { doc: Document; area: { value: string; select: () => void; remove: () => void } } {
  const area = { value: "", select: vi.fn(), remove: vi.fn() };
  return {
    doc: {
      createElement: () => area,
      body: { appendChild: vi.fn() },
    } as unknown as Document,
    area,
  };
}

describe("copyText", () => {
  it("uses the async clipboard when available", async () => {
    const writeText = vi.fn(async () => {});
    expect(await copyText("hi", { writeText })).toBe(true);
    expect(writeText).toHaveBeenCalledWith("hi");
  });

  it("falls back to execCommand when the clipboard rejects", async () => {
    const writeText = vi.fn(async () => {
      throw new Error("denied");
    });
    const { doc: d } = doc();
    expect(await copyText("hi", { writeText }, d, () => true)).toBe(true);
  });

  it("returns false when every mechanism fails", async () => {
    const writeText = vi.fn(async () => {
      throw new Error("denied");
    });
    const { doc: d } = doc();
    expect(await copyText("hi", { writeText }, d, () => false)).toBe(false);
    expect(await copyText("hi")).toBe(false);
  });
});

describe("copyHtml", () => {
  it("writes html and plain flavors when available", async () => {
    const write = vi.fn(async () => {});
    const seen: Array<{ type: string; text: string }> = [];
    vi.stubGlobal(
      "ClipboardItem",
      class {
        types: string[];
        constructor(private data: Record<string, Blob>) {
          this.types = Object.keys(data);
        }
        async getType(type: string) {
          const blob = this.data[type];
          if (!blob) throw new Error("missing flavor");
          seen.push({ type, text: await blob.text() });
          return blob;
        }
      },
    );
    try {
      expect(await copyHtml("<b>hi</b>", "hi", { writeText: vi.fn(), write })).toBe(true);
      expect(write).toHaveBeenCalledTimes(1);
      const firstCall = write.mock.calls[0] as unknown[] | undefined;
      expect(firstCall).toHaveLength(1);
      const items = (firstCall as unknown[])[0] as unknown[];
      expect(items).toHaveLength(1);
      const item = items[0] as unknown as {
        types: string[];
        getType: (t: string) => Promise<Blob>;
      };
      expect([...item.types].sort()).toEqual(["text/html", "text/plain"]);
      await item.getType("text/html");
      await item.getType("text/plain");
      expect(seen).toContainEqual({ type: "text/html", text: "<b>hi</b>" });
      expect(seen).toContainEqual({ type: "text/plain", text: "hi" });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("falls back to plain text without html", async () => {
    const writeText = vi.fn(async () => {});
    expect(await copyHtml(null, "hi", { writeText })).toBe(true);
    expect(writeText).toHaveBeenCalledWith("hi");
    expect(await copyHtml("   ", "hi", { writeText })).toBe(true);
  });

  it("falls back to plain when the flavored write rejects", async () => {
    const writeText = vi.fn(async () => {});
    const write = vi.fn(async () => {
      throw new Error("denied");
    });
    vi.stubGlobal("ClipboardItem", class {});
    try {
      expect(await copyHtml("<b>hi</b>", "hi", { writeText, write })).toBe(true);
      expect(writeText).toHaveBeenCalledWith("hi");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("copyDomHtml", () => {
  const divNode = (innerHTML: string, innerText: string): ContentNodeLike => ({
    tagName: "DIV",
    innerHTML,
    innerText,
  });

  it("copies the preview DOM verbatim with both flavors", async () => {
    const write = vi.fn(async () => {});
    const seen: Array<{ type: string; text: string }> = [];
    vi.stubGlobal(
      "ClipboardItem",
      class {
        types: string[];
        constructor(private data: Record<string, Blob>) {
          this.types = Object.keys(data);
        }
        async getType(type: string) {
          const blob = this.data[type];
          if (!blob) throw new Error("missing flavor");
          seen.push({ type, text: await blob.text() });
          return blob;
        }
      },
    );
    try {
      const html = "<p>Hi</p><ul><li>uno</li></ul>";
      const el = divNode(html, "Hi\nuno");
      expect(await copyDomHtml(() => el, { writeText: vi.fn(), write })).toBe("html");
      expect(write).toHaveBeenCalledTimes(1);
      const firstCall = write.mock.calls[0] as unknown[] | undefined;
      const items = (firstCall as unknown[])[0] as unknown[];
      const item = items[0] as unknown as {
        types: string[];
        getType: (t: string) => Promise<Blob>;
      };
      expect([...item.types].sort()).toEqual(["text/html", "text/plain"]);
      await item.getType("text/html");
      await item.getType("text/plain");
      expect(seen).toContainEqual({ type: "text/html", text: html });
      expect(seen).toContainEqual({ type: "text/plain", text: "Hi\nuno" });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("copies textarea values as plain text", async () => {
    const writeText = vi.fn(async () => {});
    const el: ContentNodeLike = { tagName: "textarea", innerHTML: "", innerText: "", value: "plain" };
    expect(await copyDomHtml(() => el, { writeText })).toBe("plain");
    expect(writeText).toHaveBeenCalledWith("plain");
  });

  it("returns false with no usable node", async () => {
    expect(await copyDomHtml(() => null, { writeText: vi.fn() })).toBe(false);
    expect(await copyDomHtml(() => divNode("   ", "x"), { writeText: vi.fn() })).toBe(false);
    expect(
      await copyDomHtml(() => {
        throw new Error("no DOM");
      }, { writeText: vi.fn() }),
    ).toBe(false);
  });

  it("falls back to plain rendered text when flavors reject", async () => {
    const writeText = vi.fn(async () => {});
    const write = vi.fn(async () => {
      throw new Error("denied");
    });
    vi.stubGlobal("ClipboardItem", class {});
    try {
      const el = divNode("<p>Hi</p>", "Hi");
      expect(await copyDomHtml(() => el, { writeText, write })).toBe("plain");
      expect(writeText).toHaveBeenCalledWith("Hi");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
