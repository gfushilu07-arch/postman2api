import { describe, expect, test } from "bun:test";
import { APP_VERSION, incrementPatchVersion } from "../src/version";

describe("application version", () => {
  test("reads the current semantic version", () => {
    expect(APP_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  test("increments the patch version", () => {
    expect(incrementPatchVersion("1.0.0")).toBe("1.0.1");
    expect(incrementPatchVersion("2.7.99")).toBe("2.7.100");
  });

  test("rejects invalid versions", () => {
    expect(() => incrementPatchVersion("v1.0")).toThrow("Invalid application version");
  });
});
