/**
 * AI transaction extraction.
 *
 * Turns one Vietnamese utterance into *n* draft transactions:
 *
 *   "Hôm nay đi chợ hết 50k, ăn uống 100k, đổ xăng 90k"
 *     → 50.000 Đi chợ · 100.000 Ăn uống · 90.000 Xăng xe
 *
 * Splitting one sentence into several transactions is the specific thing the
 * app's on-device parser cannot do today, and it is the reason this endpoint
 * exists. Single-transaction phrases should not come here at all — the offline
 * parser handles those for free, instantly, with no network.
 *
 * Two consequences follow from that, and both are load-bearing:
 *
 * 1. **The categories come from the client.** Users create their own, so the
 *    server cannot hold the list. Sending it per request also means there is no
 *    category taxonomy duplicated between the app and this repo to drift apart.
 *
 * 2. **Every failure is soft.** No API key, a refusal, a timeout, a hallucinated
 *    category — each returns an empty or partial result rather than an error the
 *    app must handle specially. The device always has the rule-based parser to
 *    fall back to, and a spending app that cannot record spending because a
 *    third-party API is slow is a worse app than one that categorises less well.
 */

import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { Hono } from 'hono';
import { z } from 'zod';

import { aiEnabled, env } from '@/env';
import { ApiError } from '@/lib/errors';
import { requireAuth, type AuthVariables } from '@/middleware/auth';

export const aiRoutes = new Hono<{ Variables: AuthVariables }>();

aiRoutes.use('*', requireAuth);

const client = aiEnabled ? new Anthropic({ apiKey: env.ANTHROPIC_API_KEY }) : null;

/* ------------------------------------------------------------------ *
 * Request
 * ------------------------------------------------------------------ */

const CategoryInput = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  kind: z.enum(['expense', 'income']),
});

const CategorizeRequest = z.object({
  text: z.string().min(1).max(2000),
  categories: z.array(CategoryInput).min(1).max(300),
  /** Epoch ms the phrase is relative to. Injected so "hôm qua" is resolvable. */
  now: z.number().int().positive().optional(),
  currency: z.string().length(3).default('VND'),
});

/* ------------------------------------------------------------------ *
 * Response schema — what the model is constrained to produce
 * ------------------------------------------------------------------ */

const ExtractedTransaction = z.object({
  categoryId: z.string().describe('Must be one of the provided category ids, copied exactly'),
  kind: z.enum(['expense', 'income']),
  amountMinor: z
    .number()
    .int()
    .describe('Amount in the currency minor unit. VND has no subunit, so 50k is 50000'),
  note: z.string().describe('Short human note in Vietnamese, with diacritics'),
  daysAgo: z
    .number()
    .int()
    .describe('0 for today, 1 for yesterday, 2 for the day before. Never negative'),
  confidence: z.number().describe('0 to 1. Below 0.6 means the user should check it'),
});

const Extraction = z.object({
  transactions: z.array(ExtractedTransaction),
});

/* ------------------------------------------------------------------ *
 * Prompt
 * ------------------------------------------------------------------ */

const INSTRUCTIONS = `Bạn trích xuất giao dịch tài chính từ câu tiếng Việt nói hoặc gõ nhanh.

QUAN TRỌNG NHẤT — một câu có thể chứa NHIỀU giao dịch:
"Hôm nay đi chợ hết 50k, ăn uống 100k, đổ xăng 90k" là BA giao dịch riêng biệt.
Mỗi số tiền tương ứng đúng một giao dịch. Không được gộp, không được bỏ sót.
Nếu câu chỉ có một số tiền thì trả về đúng một giao dịch.

Cách đọc số tiền:
- "50k", "50 nghìn", "50 ngàn"  → 50000
- "2 triệu", "2 củ", "2tr"       → 2000000
- "1 tỷ"                          → 1000000000
- "hai lăm nghìn"                 → 25000
- Số trần dưới 1000 trong ngữ cảnh chi tiêu thường là nghìn: "cà phê 45" → 45000

Ngày tháng — trả về daysAgo:
- "hôm nay", "sáng nay", "chiều nay", không nói gì → 0
- "hôm qua", "tối qua"                              → 1
- "hôm kia"                                          → 2
Ngữ cảnh thời gian nêu ở đầu câu áp dụng cho MỌI giao dịch trong câu đó.

Danh mục:
- Chỉ được dùng id có trong danh sách được cung cấp. Sao chép nguyên văn.
- Nếu không khớp danh mục nào, chọn danh mục "khác" đúng chiều thu/chi.
- Chiều mặc định là chi (expense). Chỉ chọn income khi có dấu hiệu rõ:
  "nhận lương", "được thưởng", "thu", "bán được", "lì xì".

Ghi chú: ngắn, tiếng Việt có dấu, mô tả khoản chi chứ không lặp lại số tiền.

Nếu câu không chứa giao dịch nào thì trả về mảng rỗng.`;

/* ------------------------------------------------------------------ *
 * Route
 * ------------------------------------------------------------------ */

aiRoutes.post('/categorize', async (c) => {
  if (!client) {
    throw new ApiError(
      'ai_unavailable',
      503,
      'AI categorisation is not configured on this server. Use the on-device parser.',
    );
  }

  const parsed = CategorizeRequest.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw ApiError.validation('Invalid categorize payload', parsed.error.issues);

  const { text, categories, currency } = parsed.data;
  const now = parsed.data.now ?? Date.now();

  const catalogue = categories
    .map((category) => `${category.id}\t${category.kind}\t${category.name}`)
    .join('\n');

  try {
    const response = await client.messages.parse({
      model: env.ANTHROPIC_MODEL,
      // Thinking is on by default on Opus 5 and counts against max_tokens, so
      // this is sized well above the few hundred tokens the answer itself needs.
      max_tokens: 4000,
      output_config: {
        // Classification, not reasoning. Low effort is both cheaper and faster,
        // and measurably no worse on a task this shaped.
        effort: 'low',
        format: zodOutputFormat(Extraction),
      },
      system: [
        {
          type: 'text',
          text: `${INSTRUCTIONS}\n\nĐơn vị tiền tệ: ${currency}\n\nDanh mục hợp lệ (id, chiều, tên):\n${catalogue}`,
          // The instructions and this user's category list are identical across
          // their requests, so everything above the utterance is a stable prefix
          // and is billed at cache-read rates from the second call onward.
          cache_control: { type: 'ephemeral' },
        },
      ],
      messages: [{ role: 'user', content: text }],
    });

    if (response.stop_reason === 'refusal') {
      // Vanishingly unlikely for "đi chợ 50k", but the client must never receive
      // a malformed body, so it degrades to "nothing extracted" like any other
      // miss and the device falls back to its own parser.
      console.warn('[ai] refusal:', response.stop_details);
      return c.json({ transactions: [], degraded: true });
    }

    const output = response.parsed_output;
    if (!output) return c.json({ transactions: [], degraded: true });

    const validIds = new Map(categories.map((category) => [category.id, category]));
    const startOfToday = new Date(now).setHours(0, 0, 0, 0);

    const transactions = output.transactions
      // A model can return an id that was never offered. Dropping those rows is
      // better than writing a transaction pointing at a category that does not
      // exist, which would render as a blank row the user cannot fix.
      .filter((transaction) => validIds.has(transaction.categoryId))
      .filter((transaction) => Number.isFinite(transaction.amountMinor) && transaction.amountMinor > 0)
      .map((transaction) => {
        const daysAgo = Math.max(0, Math.min(365, Math.trunc(transaction.daysAgo)));
        const occurredAt = new Date(startOfToday).setDate(new Date(startOfToday).getDate() - daysAgo);

        return {
          categoryId: transaction.categoryId,
          // The catalogue is authoritative on direction; a model that labels a
          // salary category as an expense should not be able to invert a report.
          kind: validIds.get(transaction.categoryId)!.kind,
          amountMinor: Math.round(transaction.amountMinor),
          note: transaction.note.slice(0, 200),
          occurredAt,
          confidence: Math.max(0, Math.min(1, transaction.confidence)),
        };
      });

    return c.json({
      transactions,
      /*
       * `inputTokens` counts only what was billed at full rate — cached and
       * cache-written tokens are reported separately and are NOT included in it.
       * Total prompt size is the sum of all three; subtracting one from another
       * gives a negative number, which is how this was got wrong once already.
       */
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
        cacheWriteTokens: response.usage.cache_creation_input_tokens ?? 0,
      },
    });
  } catch (error) {
    // Upstream trouble is logged here and reported as a soft failure. The app
    // treats an empty result and a 503 identically: use the offline parser.
    console.error('[ai] categorize failed:', error);
    throw new ApiError('ai_failed', 502, 'AI categorisation failed. Fall back to the on-device parser.');
  }
});
