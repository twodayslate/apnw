import { describe, expect, it } from "vitest";
import {
  requireEventData,
  requireEventName,
} from "../src/event";

describe("application event data", () => {
  it("accepts app-defined event names and canonicalizes object keys", () => {
    expect(requireEventName("check.response-ready")).toBe(
      "check.response-ready",
    );
    expect(
      requireEventData({
        z: true,
        nested: { second: 2, first: 1 },
        a: ["value", null],
      }).dataJSON,
    ).toBe(
      '{"a":["value",null],"nested":{"first":1,"second":2},"z":true}',
    );
  });

  it("defaults omitted data to an empty object", () => {
    expect(requireEventData(undefined)).toEqual({
      data: {},
      dataJSON: "{}",
    });
  });

  it("rejects malformed names and nonobject application data", () => {
    for (const value of ["", "Uppercase", ".leading", "a".repeat(65)]) {
      expect(() => requireEventName(value)).toThrow("Invalid request");
    }
    for (const value of [null, "value", [1, 2, 3]]) {
      expect(() => requireEventData(value)).toThrow("Invalid request");
    }
  });

  it("bounds nested application data", () => {
    let value: unknown = {};
    for (let depth = 0; depth < 18; depth += 1) {
      value = { nested: value };
    }
    expect(() => requireEventData(value)).toThrow("Invalid request");
    expect(() =>
      requireEventData({ values: Array.from({ length: 513 }, () => true) }),
    ).toThrow("Invalid request");
  });
});
