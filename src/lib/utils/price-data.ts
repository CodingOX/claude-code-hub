import type { ModelPriceData } from "@/types/model-price";
import { collectAdditionalPriceLikeNumbers } from "./model-price-fields";

function hasNumericPriceMatching(values: unknown[], accept: (value: number) => boolean): boolean {
  return values.some(
    (value) => typeof value === "number" && Number.isFinite(value) && accept(value)
  );
}

function collectNumericCosts(priceData: ModelPriceData): unknown[] {
  const longContextPricing = priceData.long_context_pricing;
  return [
    priceData.input_cost_per_token,
    priceData.output_cost_per_token,
    priceData.input_cost_per_request,
    priceData.cache_creation_input_token_cost,
    priceData.cache_creation_input_token_cost_above_1hr,
    priceData.cache_read_input_token_cost,
    priceData.input_cost_per_token_above_200k_tokens,
    priceData.output_cost_per_token_above_200k_tokens,
    priceData.cache_creation_input_token_cost_above_200k_tokens,
    priceData.cache_read_input_token_cost_above_200k_tokens,
    priceData.cache_creation_input_token_cost_above_1hr_above_200k_tokens,
    priceData.input_cost_per_token_above_200k_tokens_priority,
    priceData.output_cost_per_token_above_200k_tokens_priority,
    priceData.cache_read_input_token_cost_above_200k_tokens_priority,
    priceData.input_cost_per_token_above_272k_tokens,
    priceData.output_cost_per_token_above_272k_tokens,
    priceData.cache_creation_input_token_cost_above_272k_tokens,
    priceData.cache_read_input_token_cost_above_272k_tokens,
    priceData.cache_creation_input_token_cost_above_1hr_above_272k_tokens,
    priceData.input_cost_per_token_above_272k_tokens_priority,
    priceData.output_cost_per_token_above_272k_tokens_priority,
    priceData.cache_read_input_token_cost_above_272k_tokens_priority,
    priceData.input_cost_per_token_priority,
    priceData.output_cost_per_token_priority,
    priceData.cache_read_input_token_cost_priority,
    priceData.output_cost_per_image,
    longContextPricing?.input_multiplier,
    longContextPricing?.output_multiplier,
    longContextPricing?.cache_creation_input_multiplier,
    longContextPricing?.cache_creation_input_multiplier_above_1hr,
    longContextPricing?.cache_read_input_multiplier,
    longContextPricing?.input_cost_per_token,
    longContextPricing?.output_cost_per_token,
    longContextPricing?.cache_creation_input_token_cost,
    longContextPricing?.cache_creation_input_token_cost_above_1hr,
    longContextPricing?.cache_read_input_token_cost,
  ];
}

/**
 * 遍历价格数据里所有“价格类”数字字段，判断是否存在满足 accept 条件的取值。
 * 覆盖范围：顶层计费字段、long_context_pricing、pricing[provider] 节点、
 * search_context_cost_per_query，以及键名带 cost/price/multiplier 等特征词的嵌套字段。
 */
function hasPriceMatching(priceData: ModelPriceData, accept: (value: number) => boolean): boolean {
  if (
    hasNumericPriceMatching(
      [...collectNumericCosts(priceData), ...collectAdditionalPriceLikeNumbers(priceData)],
      accept
    )
  ) {
    return true;
  }

  const pricing = priceData.pricing;
  if (pricing && typeof pricing === "object" && !Array.isArray(pricing)) {
    for (const value of Object.values(pricing)) {
      if (value && typeof value === "object" && !Array.isArray(value)) {
        if (hasNumericPriceMatching(Object.values(value), accept)) {
          return true;
        }
      }
    }
  }

  const searchCosts = priceData.search_context_cost_per_query;
  if (searchCosts) {
    const searchCostFields = [
      searchCosts.search_context_size_high,
      searchCosts.search_context_size_low,
      searchCosts.search_context_size_medium,
    ];
    return hasNumericPriceMatching(searchCostFields, accept);
  }

  return false;
}

/**
 * 判断价格数据是否包含至少一个可用于计费的价格字段。
 * 避免把数据库中的 `{}` 或仅包含元信息的记录当成有效价格。
 *
 * 注意：价格为 0 也算有效（免费模型、按套餐计费的渠道都会上报 0 单价），
 * 需要区分“0 价”与“正价”时用 hasPositivePriceData。
 */
export function hasValidPriceData(priceData: ModelPriceData): boolean {
  return hasPriceMatching(priceData, (value) => value >= 0);
}

/**
 * 判断价格数据是否至少含有一个严格大于 0 的价格。
 *
 * 与 hasValidPriceData 的区别：0 价记录“合法但无计费信息量”。
 * 典型场景是云价格表里的 Token 套餐 / 包月渠道（单价填 0，实际按套餐收费），
 * 以及免费模型的全部渠道。多 provider 价格表里挑选计费节点时必须让带正价的节点优先，
 * 否则 0 价节点会凭借明细字段数、字典序等次要排序键胜出，把整批请求计费成 0。
 */
export function hasPositivePriceData(priceData: ModelPriceData): boolean {
  return hasPriceMatching(priceData, (value) => value > 0);
}
