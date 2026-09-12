import { describe, expect, it, vi } from "vitest";
import { copyText } from "./clipboard";

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
