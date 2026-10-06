// Live GET /v1/models response. Full observed field union (43 fields, stable):
// id, object, created, owned_by, data_policy{zdr,zdr_on_request,no_training,providers[]},
// supports_tools, supports_embeddings, supports_image_generation, emits_images,
// supports_structured_output, supports_completions, supports_temperature, supports_top_p,
// supports_top_k, supports_logprobs, supports_frequency_penalty, supports_presence_penalty,
// supports_reasoning, reasoning_effort, supported_reasoning_efforts, sampling_requires_reasoning_none,
// reasoning_output_exposed, reasoning_output_hidden, reasoning_content_native,
// system_messages_leading_only, chat_max_tokens_field, minimum/maximum_temperature/top_p/top_k,
// context_window_tokens, maximum_output_tokens, input/output/cached_input/cache_write
// _cost_per_million_tokens_usd (legacy flat), service_tier_pricing_enabled,
// reports_cached_input_tokens, reports_cache_creation_input_tokens, reports_reasoning_tokens,
// pricing{...all *_nano_usd_per_million_tokens}
export interface GatewayPricing {
  // Fixture truth (2026-10-06 capture): pricing keys are "*_nano_usd_per_million_tokens"
  // (the plan's short input/cached_input names don't exist on the wire); the wire payload
  // also carries suffixed keys (cache_creation_1h_*, reasoning_*, cache_write_*) and
  // long_context/flex/priority tier objects — documented in the union comment below.
  input_nano_usd_per_million_tokens?: number | null
  cached_input_nano_usd_per_million_tokens?: number | null
  cache_creation_input_nano_usd_per_million_tokens?: number | null
  output_nano_usd_per_million_tokens?: number | null
}
export interface GatewayModel {
  id: string
  supports_completions?: boolean | null
  supports_tools?: boolean | null
  supports_reasoning?: boolean | null
  reasoning_content_native?: boolean | null
  chat_max_tokens_field?: string | null
  context_window_tokens?: number | null
  maximum_output_tokens?: number | null
  pricing?: GatewayPricing | null
  data_policy?: { providers?: Array<{ provider: string }> } | null
}
export interface GatewayModelsResponse {
  object: string
  data: GatewayModel[]
}
