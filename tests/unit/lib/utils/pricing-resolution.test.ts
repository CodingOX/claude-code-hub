import { describe, expect, test } from "vitest";
import type { ModelPrice } from "@/types/model-price";
import { resolvePricingForModelRecords } from "@/lib/utils/pricing-resolution";

function makeRecord(
  modelName: string,
  priceData: ModelPrice["priceData"],
  source: ModelPrice["source"] = "litellm"
): ModelPrice {
  const now = new Date("2026-03-06T00:00:00.000Z");
  return {
    id: Math.floor(Math.random() * 100000),
    modelName,
    priceData,
    source,
    createdAt: now,
    updatedAt: now,
  };
}

describe("resolvePricingForModelRecords", () => {
  test("falls back from chatgpt to openai pricing for gpt-5.5 alias models", () => {
    const aliasRecord = makeRecord("gpt-5.5", {
      mode: "responses",
      model_family: "gpt",
      litellm_provider: "chatgpt",
      pricing: {
        openai: {
          input_cost_per_token: 0.0000025,
          output_cost_per_token: 0.000015,
          cache_read_input_token_cost: 2.5e-7,
        },
        openrouter: {
          input_cost_per_token: 0.0000025,
          output_cost_per_token: 0.000015,
          cache_read_input_token_cost: 2.5e-7,
        },
      },
    });

    const resolved = resolvePricingForModelRecords({
      provider: {
        id: 1,
        name: "ChatGPT",
        url: "https://chatgpt.com/backend-api/codex",
      } as never,
      primaryModelName: "gpt-5.5",
      fallbackModelName: null,
      primaryRecord: aliasRecord,
      fallbackRecord: null,
    });

    expect(resolved).not.toBeNull();
    expect(resolved?.resolvedPricingProviderKey).toBe("openai");
    expect(resolved?.source).toBe("official_fallback");
    expect(resolved?.priceData.input_cost_per_token).toBe(0.0000025);
  });

  test("falls back from redirected date model to alias model for provider-specific pricing", () => {
    const datedRecord = makeRecord("gpt-5.5-2026-06-02", {
      mode: "responses",
      model_family: "gpt",
      litellm_provider: "openai",
      input_cost_per_token: 0.0000025,
      output_cost_per_token: 0.000015,
      cache_read_input_token_cost: 2.5e-7,
      pricing: {
        openai: {
          input_cost_per_token: 0.0000025,
          output_cost_per_token: 0.000015,
          cache_read_input_token_cost: 2.5e-7,
        },
      },
    });

    const aliasRecord = makeRecord("gpt-5.5", {
      mode: "responses",
      model_family: "gpt",
      litellm_provider: "chatgpt",
      pricing: {
        openrouter: {
          input_cost_per_token: 0.0000025,
          output_cost_per_token: 0.000015,
          cache_read_input_token_cost: 2.5e-7,
        },
      },
    });

    const resolved = resolvePricingForModelRecords({
      provider: {
        id: 2,
        name: "OpenRouter",
        url: "https://openrouter.ai/api/v1",
      } as never,
      primaryModelName: "gpt-5.5-2026-06-02",
      fallbackModelName: "gpt-5.5",
      primaryRecord: datedRecord,
      fallbackRecord: aliasRecord,
    });

    expect(resolved).not.toBeNull();
    expect(resolved?.resolvedModelName).toBe("gpt-5.5");
    expect(resolved?.resolvedPricingProviderKey).toBe("openrouter");
    expect(resolved?.source).toBe("cloud_model_fallback");
  });

  test("prefers local manual prices over cloud multi-provider pricing", () => {
    const manualRecord = makeRecord(
      "gpt-5.5",
      {
        mode: "responses",
        input_cost_per_token: 0.0000099,
        output_cost_per_token: 0.0000199,
        selected_pricing_provider: "manual-custom",
      },
      "manual"
    );

    const cloudRecord = makeRecord("gpt-5.5", {
      mode: "responses",
      pricing: {
        openai: {
          input_cost_per_token: 0.0000025,
          output_cost_per_token: 0.000015,
        },
      },
    });

    const resolved = resolvePricingForModelRecords({
      provider: {
        id: 1,
        name: "ChatGPT",
        url: "https://chatgpt.com/backend-api/codex",
      } as never,
      primaryModelName: "gpt-5.5",
      fallbackModelName: null,
      primaryRecord: manualRecord,
      fallbackRecord: cloudRecord,
    });

    expect(resolved).not.toBeNull();
    expect(resolved?.source).toBe("local_manual");
    expect(resolved?.priceData.input_cost_per_token).toBe(0.0000099);
    expect(resolved?.resolvedPricingProviderKey).toBe("manual-custom");
  });

  test("official anthropic fallback clears stale long-context fields from unrelated provider top-level data", () => {
    const cloudRecord = makeRecord("claude-sonnet-4-6", {
      mode: "chat",
      model_family: "claude-sonnet",
      litellm_provider: "bedrock_converse",
      input_cost_per_token: 0.000003,
      output_cost_per_token: 0.000015,
      input_cost_per_token_above_200k_tokens: 0.000006,
      output_cost_per_token_above_200k_tokens: 0.0000225,
      pricing: {
        anthropic: {
          input_cost_per_token: 0.000003,
          output_cost_per_token: 0.000015,
        },
        openrouter: {
          input_cost_per_token: 0.000003,
          output_cost_per_token: 0.000015,
          input_cost_per_token_above_200k_tokens: 0.000006,
          output_cost_per_token_above_200k_tokens: 0.0000225,
        },
      },
    });

    const resolved = resolvePricingForModelRecords({
      provider: null,
      primaryModelName: "claude-sonnet-4-6",
      fallbackModelName: null,
      primaryRecord: cloudRecord,
      fallbackRecord: null,
    });

    expect(resolved).not.toBeNull();
    expect(resolved?.source).toBe("official_fallback");
    expect(resolved?.resolvedPricingProviderKey).toBe("anthropic");
    expect(resolved?.priceData.input_cost_per_token).toBe(0.000003);
    expect(resolved?.priceData.input_cost_per_token_above_200k_tokens).toBeUndefined();
    expect(resolved?.priceData.output_cost_per_token_above_200k_tokens).toBeUndefined();
  });

  test("provider merge keeps shared top-level request fees and long_context_pricing", () => {
    const cloudRecord = makeRecord("gpt-5.5", {
      mode: "responses",
      model_family: "gpt",
      litellm_provider: "azure",
      input_cost_per_request: 0.123,
      long_context_pricing: {
        threshold_tokens: 272000,
        input_cost_per_token: 0.000005,
      },
      pricing: {
        openai: {
          input_cost_per_token: 0.0000025,
          output_cost_per_token: 0.000015,
        },
        azure: {
          input_cost_per_token: 0.0000027,
          output_cost_per_token: 0.000016,
        },
      },
    });

    const resolved = resolvePricingForModelRecords({
      provider: {
        id: 4,
        name: "OpenAI",
        url: "https://api.openai.com/v1/responses",
      } as never,
      primaryModelName: "gpt-5.5",
      fallbackModelName: null,
      primaryRecord: cloudRecord,
      fallbackRecord: null,
    });

    expect(resolved).not.toBeNull();
    expect(resolved?.resolvedPricingProviderKey).toBe("openai");
    expect(resolved?.priceData.input_cost_per_request).toBe(0.123);
    expect(resolved?.priceData.long_context_pricing).toEqual({
      threshold_tokens: 272000,
      input_cost_per_token: 0.000005,
    });
  });

  test("skips all-zero token-plan channels when another provider node carries a real price", () => {
    // 真实回归场景：deepseek/deepseek-v4.1-flash 的云价格表里，
    // alibaba-token-plan-cn（Token 套餐，单价全 0）与 crossmodel 的明细字段数相同，
    // 修复前 0 价节点凭字典序胜出，导致整批请求计费为 0。
    const record = makeRecord("deepseek/deepseek-v4.1-flash", {
      mode: "chat",
      pricing: {
        "alibaba-token-plan-cn": {
          provider_model_id: "deepseek-v4.1-flash",
          input_cost_per_token: 0,
          output_cost_per_token: 0,
          cache_read_input_token_cost: 0,
          cache_creation_input_token_cost: 0,
        },
        crossmodel: {
          provider_model_id: "deepseek/deepseek-v4.1-flash",
          input_cost_per_token: 0.00000027,
          output_cost_per_token: 0.00000108,
          cache_read_input_token_cost: 0.0000000054,
          cache_creation_input_token_cost: 0.00000027,
        },
      },
    });

    const resolved = resolvePricingForModelRecords({
      provider: {
        id: 180,
        name: "CCG_Gmail",
        url: "https://api.commandcode.ai/provider/v1",
      } as never,
      primaryModelName: "deepseek/deepseek-v4.1-flash",
      fallbackModelName: null,
      primaryRecord: record,
      fallbackRecord: null,
    });

    expect(resolved).not.toBeNull();
    expect(resolved?.resolvedPricingProviderKey).toBe("crossmodel");
    expect(resolved?.source).toBe("priority_fallback");
    expect(resolved?.priceData.input_cost_per_token).toBe(0.00000027);
  });

  test("still resolves a genuinely free model whose every provider node is zero-priced", () => {
    // 免费模型的全部渠道单价都是 0：降级排序不能让结果变成 null，否则会丢失价格来源信息。
    const record = makeRecord("free-model", {
      mode: "chat",
      pricing: {
        alpha: { input_cost_per_token: 0, output_cost_per_token: 0 },
        beta: { input_cost_per_token: 0, output_cost_per_token: 0 },
      },
    });

    const resolved = resolvePricingForModelRecords({
      provider: null,
      primaryModelName: "free-model",
      fallbackModelName: null,
      primaryRecord: record,
      fallbackRecord: null,
    });

    expect(resolved).not.toBeNull();
    expect(resolved?.source).toBe("priority_fallback");
    expect(resolved?.priceData.input_cost_per_token).toBe(0);
  });

  test("prefers a real price over a zero-priced node that has more detail fields", () => {
    // 0 价节点即便明细字段更多也必须让位，否则“字段最多”会盖过“真的能计费”。
    const record = makeRecord("detail-heavy-model", {
      mode: "chat",
      pricing: {
        aaa: {
          input_cost_per_token: 0,
          output_cost_per_token: 0,
          cache_read_input_token_cost: 0,
          cache_creation_input_token_cost: 0,
          input_cost_per_token_above_200k_tokens: 0,
          output_cost_per_token_above_200k_tokens: 0,
        },
        zzz: {
          input_cost_per_token: 0.000002,
          output_cost_per_token: 0.000008,
        },
      },
    });

    const resolved = resolvePricingForModelRecords({
      provider: null,
      primaryModelName: "detail-heavy-model",
      fallbackModelName: null,
      primaryRecord: record,
      fallbackRecord: null,
    });

    expect(resolved?.resolvedPricingProviderKey).toBe("zzz");
    expect(resolved?.priceData.input_cost_per_token).toBe(0.000002);
  });
});
