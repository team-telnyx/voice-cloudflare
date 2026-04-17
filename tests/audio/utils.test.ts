import { describe, it, expect } from "vitest";
import { float32ToInt16, computeRMS } from "../../src/audio/utils.js";

describe("float32ToInt16", () => {
  it("converts silence (zeros) to zero Int16 samples", () => {
    const input = new Float32Array([0, 0, 0, 0]);
    const result = float32ToInt16(input);
    expect(result).toBeInstanceOf(Int16Array);
    expect(result.length).toBe(4);
    expect(Array.from(result)).toEqual([0, 0, 0, 0]);
  });

  it("converts full-scale positive to 32767", () => {
    const input = new Float32Array([1.0]);
    const result = float32ToInt16(input);
    expect(result[0]).toBe(32767);
  });

  it("converts full-scale negative to -32768", () => {
    const input = new Float32Array([-1.0]);
    const result = float32ToInt16(input);
    expect(result[0]).toBe(-32768);
  });

  it("clamps values beyond -1..1 range", () => {
    const input = new Float32Array([1.5, -1.5]);
    const result = float32ToInt16(input);
    expect(result[0]).toBe(32767);
    expect(result[1]).toBe(-32768);
  });

  it("converts a mid-range value correctly", () => {
    const input = new Float32Array([0.5]);
    const result = float32ToInt16(input);
    // 0.5 * 32767 = 16383.5, truncated to 16383
    expect(result[0]).toBe(16383);
  });
});

describe("computeRMS", () => {
  it("returns 0 for silence", () => {
    const input = new Float32Array([0, 0, 0, 0]);
    expect(computeRMS(input)).toBe(0);
  });

  it("returns 1 for full-scale DC signal", () => {
    const input = new Float32Array([1, 1, 1, 1]);
    expect(computeRMS(input)).toBeCloseTo(1.0, 5);
  });

  it("computes RMS for a known signal", () => {
    // RMS of [0.5, -0.5, 0.5, -0.5] = sqrt(mean(0.25)) = 0.5
    const input = new Float32Array([0.5, -0.5, 0.5, -0.5]);
    expect(computeRMS(input)).toBeCloseTo(0.5, 5);
  });

  it("returns 0 for empty array", () => {
    const input = new Float32Array([]);
    expect(computeRMS(input)).toBe(0);
  });
});
