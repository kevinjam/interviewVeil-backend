# Plan unit economics (revenue − API)

Variable costs only: **Anthropic** chat + **OpenAI** `gpt-4o-mini-transcribe` for Listen.

**Routing (production / Anthropic):** practice uses the plan tier; live assist uses **`MODEL_EXPLAIN`** (Sonnet). **OpenRouter dev** uses one `MODEL_OPENROUTER` slug for everything—not used for margin math.

Run the calculator (tweak assumptions in the script):

```bash
cd backend && npm run economics
```

## Price list used (Oct 2026 list)

| Provider | SKU | Input / MTok | Output / MTok | Notes |
|----------|-----|--------------|---------------|--------|
| Anthropic | Haiku 5.5 | $0.10 | $0.50 | ≤100k context |
| Anthropic | Haiku 4.5 | $1.00 | $5.00 | If `MODEL_HAIKU` still 4.5 |
| Anthropic | Sonnet 5.5 | $2.00 | $10.00 | Professional |
| Anthropic | Opus 5.5 | $4.00 | $20.00 | Expert |
| OpenAI | gpt-4o-mini-transcribe | — | — | **~$0.003 / audio minute** |

Sources: [Anthropic pricing](https://platform.claude.com/docs/en/about-claude/pricing), [OpenAI pricing](https://developers.openai.com/api/docs/pricing).

## What counts as cost

| User action | Billed to you | Billed to user |
|-------------|---------------|----------------|
| Practice question / review | 1 × Anthropic call | 1 token |
| Screenshot answer | 1 × Anthropic call (large image input) | 1 token |
| Listen follow-up AI | 1 × Anthropic call | 1 token |
| Listen transcription | OpenAI STT (seconds) | listen minutes |

**Not included:** AWS, Postgres, support, Stripe disputes, failed/refunded API calls (usually small).

## Default usage assumptions (script)

- **50% “typical”** and **100% “max”** of monthly token + listen caps.
- **70%** of AI responses = practice (~3k in / 2k out tokens).
- **30%** = live assist (~15k in / 2.5k out — vision-heavy).
- Stripe **2.9% + $0.30** on paid subscriptions.

Adjust `ASSUMPTIONS` in `scripts/plan-unit-economics.ts` when you have real `usage_history` averages.

## Interpretation

- **Essential** stays very high margin if you ship **Haiku 5.5**; Haiku 4.5 is ~10× more expensive per token.
- **Professional** is healthy at typical use; max use still ~70% margin after Stripe.
- **Expert** at **full 500 tokens + 400 min** is tight (~15% after Stripe) because Opus × high volume dominates; STT is minor.
- **Free** is a small acquisition cost (~$0.04/user/month at max caps).

Validate with production: `avg(input_tokens)`, `avg(output_tokens)`, and `kind` from `usage_history`.
