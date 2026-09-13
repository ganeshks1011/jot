import { describe, expect, it, vi } from "vitest";
import { copyHtml, copyText } from "./clipboard";

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
