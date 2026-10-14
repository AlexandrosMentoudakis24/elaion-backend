import { describe, expect, test } from "bun:test";
import { Body, parseId, parsePagination, parseYear } from "./validation.js";
import { ValidationError } from "../errors/app-errors.js";
import { SOIL_TYPES } from "../models/index.js";

const body = (raw: unknown) => new Body(raw);

describe("Body required fields", () => {
  test("rejects a non-object payload", () => {
    expect(() => body("nope")).toThrow(ValidationError);
    expect(() => body([1, 2])).toThrow(ValidationError);
  });

  test("requires presence", () => {
    expect(() => body({}).string("name")).toThrow(ValidationError);
  });

  test("treats null as missing", () => {
    expect(() => body({ name: null }).string("name")).toThrow(ValidationError);
  });

  test("rejects blank strings", () => {
    expect(() => body({ name: "   " }).string("name")).toThrow(ValidationError);
  });

  test("returns strings", () => {
    expect(body({ name: "North Grove" }).string("name")).toBe("North Grove");
  });
});

describe("Body numbers", () => {
  test("rejects non-numbers", () => {
    expect(() => body({ area: "12" }).number("area")).toThrow(ValidationError);
    expect(() => body({ area: Number.NaN }).number("area")).toThrow(ValidationError);
  });

  test("integer rejects fractions", () => {
    expect(() => body({ trees: 1.5 }).integer("trees")).toThrow(ValidationError);
    expect(body({ trees: 640 }).integer("trees")).toBe(640);
  });

  test("optionalNumber defaults to undefined", () => {
    expect(body({}).optionalNumber("acidity")).toBeUndefined();
    expect(body({ acidity: 0 }).optionalNumber("acidity")).toBe(0);
  });
});

describe("Body enums", () => {
  test("falls back when absent", () => {
    expect(body({}).enum("soil", SOIL_TYPES, "Clay-loam")).toBe("Clay-loam");
  });

  test("accepts the exact display value", () => {
    expect(body({ soil: "Rocky" }).enum("soil", SOIL_TYPES, "Clay-loam")).toBe("Rocky");
  });

  test("accepts loose casing and separators, as the client sends raw enum names", () => {
    expect(body({ soil: "clayLoam" }).enum("soil", SOIL_TYPES, "Clay-loam")).toBe("Clay-loam");
    expect(body({ soil: "rain-fed" }).enum("soil", SOIL_TYPES, "Clay-loam")).toBe("Clay-loam");
  });

  test("falls back for unknown values", () => {
    expect(body({ soil: "volcanic" }).enum("soil", SOIL_TYPES, "Clay-loam")).toBe("Clay-loam");
  });
});

describe("Body dates", () => {
  test("accepts ISO calendar dates", () => {
    expect(body({ startDate: "2025-10-08" }).date("startDate")).toBe("2025-10-08");
  });

  test("rejects wrong formats", () => {
    expect(() => body({ startDate: "08/10/2025" }).date("startDate")).toThrow(ValidationError);
    expect(() => body({ startDate: "2025-1-1" }).date("startDate")).toThrow(ValidationError);
  });

  test("rejects impossible dates", () => {
    expect(() => body({ startDate: "2025-02-30" }).date("startDate")).toThrow(ValidationError);
  });

  test("optionalDate maps absence to null", () => {
    expect(body({}).optionalDate("endDate")).toBeNull();
    expect(body({ endDate: null }).optionalDate("endDate")).toBeNull();
  });
});

describe("Body workerPays", () => {
  test("defaults to an empty list", () => {
    expect(body({}).workerPays("workers")).toEqual([]);
  });

  test("parses valid entries", () => {
    const parsed = body({ workers: [{ employeeId: 1, pay: 120 }] }).workerPays("workers");
    expect(parsed).toEqual([{ employeeId: 1, pay: 120 }]);
  });

  test("rejects malformed entries", () => {
    expect(() => body({ workers: "nope" }).workerPays("workers")).toThrow(ValidationError);
    expect(() => body({ workers: [1] }).workerPays("workers")).toThrow(ValidationError);
    expect(() => body({ workers: [{ employeeId: "1", pay: 2 }] }).workerPays("workers")).toThrow(
      ValidationError,
    );
    expect(() => body({ workers: [{ employeeId: 1, pay: 1.5 }] }).workerPays("workers")).toThrow(
      ValidationError,
    );
  });
});

describe("parseId", () => {
  test("parses positive integers", () => {
    expect(parseId("42")).toBe(42);
  });

  test("rejects non-positive and malformed ids", () => {
    for (const value of ["0", "-1", "1.5", "abc", "", undefined]) {
      expect(() => parseId(value)).toThrow(ValidationError);
    }
  });
});

describe("parseYear", () => {
  test("requires four digits", () => {
    expect(parseYear("2024")).toBe(2024);
    expect(() => parseYear("24")).toThrow(ValidationError);
    expect(() => parseYear("20245")).toThrow(ValidationError);
  });
});

describe("parsePagination", () => {
  test("absent params mean no pagination", () => {
    expect(parsePagination(new URLSearchParams())).toBeUndefined();
    expect(parsePagination(new URLSearchParams("sort=name"))).toBeUndefined();
  });

  test("page only uses the default limit", () => {
    expect(parsePagination(new URLSearchParams("page=3"))).toEqual({
      skip: 100,
      limit: 50,
    });
  });

  test("limit only starts at the first page", () => {
    expect(parsePagination(new URLSearchParams("limit=20"))).toEqual({
      skip: 0,
      limit: 20,
    });
  });

  test("page and limit combine", () => {
    expect(parsePagination(new URLSearchParams("page=2&limit=25"))).toEqual({
      skip: 25,
      limit: 25,
    });
  });

  test("clamps the limit to the maximum", () => {
    expect(parsePagination(new URLSearchParams("limit=9999"))).toEqual({
      skip: 0,
      limit: 200,
    });
  });

  test("rejects malformed and non-positive values", () => {
    for (const raw of [
      "page=0",
      "page=-1",
      "page=abc",
      "page=",
      "page=1.5",
      "limit=0",
      "limit=x",
      "limit=-5",
    ]) {
      expect(() => parsePagination(new URLSearchParams(raw))).toThrow(
        ValidationError,
      );
    }
  });
});
