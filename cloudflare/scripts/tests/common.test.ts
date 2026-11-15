import { describe, expect, it } from "vitest";
import { workerUrl } from "../common";

describe("deployed test URL arguments", () => {
  const address = "https://agent.example.com";
  it("uses the environment URL unless an explicit URL is supplied", () => {
    expect(workerUrl([], address).origin).toBe(address);
    const override = "https://override.example.com";
    expect(workerUrl([override], address).origin).toBe(override);
    expect(() => workerUrl([], "https://user:pass@agent.example.com")).toThrow();
  });
  it("accepts a positional URL when npm consumes the named flag", () => {
    expect(workerUrl([address]).origin).toBe(address);
  });
  it("continues accepting named and equals-style URL flags", () => {
    expect(workerUrl(["--url", address]).origin).toBe(address);
    expect(workerUrl([`--url=${address}`]).origin).toBe(address);
  });
  it("rejects missing, ambiguous, and unknown arguments", () => {
    expect(() => workerUrl([])).toThrow("Supply");
    expect(() => workerUrl([address, address])).toThrow("exactly one");
    expect(() => workerUrl(["--url", address, address])).toThrow("exactly one");
    expect(() => workerUrl(["--unknown", address])).toThrow();
  });
  it("permits local HTTP but rejects remote HTTP, other schemes, and credentials", () => {
    expect(workerUrl(["http://localhost:8787"]).origin).toBe(
      "http://localhost:8787",
    );
    for (const invalid of [
      "http://remote.example.com",
      "ftp://localhost",
      "https://secret@remote.example.com",
      `${address}?token=secret`,
    ]) {
      expect(() => workerUrl([invalid])).toThrow();
    }
  });
});
