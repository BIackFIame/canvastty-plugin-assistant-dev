Provider quota shapes (hand-written from public sources, no account data). NOW = 2026-10-18T12:00:00Z.
- claude-oauth-usage*.json: GET https://api.anthropic.com/api/oauth/usage (what CanvasTTY's LimitsService reads):
  five_hour / seven_day {utilization, resets_at}. "-early" is the same account after an early reset (utilization 0, new window).
- codex-rate-limits*.json: Codex app-server account/rateLimits/read (GetAccountRateLimitsResponse, openai/codex
  app-server-protocol v2): rateLimits {primary, secondary: {usedPercent, windowDurationMins, resetsAt (s)}},
  rateLimitsByLimitId, rateLimitResetCredits {availableCount, credits}. "-banked" after a banked reset was redeemed.
- exit-lines.json: limit messages as the CLIs print them (Claude Code, Codex protocol/src/error.rs, Z.AI api-code).
- claude-oauth-usage-early-kept.json: an early reset where the provider keeps showing the old reset time; -noise: a moved reset time and small dips (not resets).
