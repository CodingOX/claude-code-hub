import { describe, expect, test } from "vitest";
import { hasPositivePriceData, hasValidPriceData } from "@/lib/utils/price-data";

describe("hasPositivePriceData", () => {
  test("treats an all-zero provider node as valid but not positive", () => {
    // 真实场景：云价格表里的 Token 套餐渠道把单价全部填 0（按套餐包收费，不按量计价）
    const zeroNode = {
      provider_model_id: "deepseek-v4.1-flash",
      input_cost_per_token: 0,
      output_cost_per_token: 0,
      cache_read_input_token_cost: 0,
      cache_creation_input_token_cost: 0,
    };

    expect(hasValidPriceData(zeroNode)).toBe(true);
    expect(hasPositivePriceData(zeroNode)).toBe(false);
  });

  test("detects a positive per-token price", () => {
    expect(
      hasPositivePriceData({
        input_cost_per_token: 0.00000027,
        output_cost_per_token: 0.00000108,
      })
    ).toBe(true);
  });

  test("detects a positive per-request fee even without per-token prices", () => {
    expect(hasPositivePriceData({ input_cost_per_request: 5 })).toBe(true);
  });

  test("scans nested pricing nodes", () => {
    expect(
      hasPositivePriceData({
        pricing: {
          alibaba: { input_cost_per_token: 0, output_cost_per_token: 0 },
          openrouter: { input_cost_per_token: 0.00000015 },
        },
      })
    ).toBe(true);
  });

  test("reports false for an empty record and for non price-like metadata", () => {
    expect(hasPositivePriceData({})).toBe(false);
    expect(hasPositivePriceData({ max_tokens: 4096, output_vector_size: 1024 })).toBe(false);
  });
});
