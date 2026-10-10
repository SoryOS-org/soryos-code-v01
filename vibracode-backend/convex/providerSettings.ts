import { query, mutation, QueryCtx } from './_generated/server';
import { v } from 'convex/values';

/**
 * Per-user provider API keys (OpenRouter / Mistral / Gemini).
 *
 * Keys are stored encrypted at rest by Convex and are NEVER returned to the
 * client. The web UI only reads a masked status ({ configured, masked }),
 * while the backend engine reads the plaintext through
 * `getProviderSecretsInternal` (server-only, mirroring `sessions.getByIdInternal`).
 *
 * The engine prefers a user's own key over the deployment env vars:
 *   user key  >  process.env (OPENROUTER_API_KEY / MISTRAL_API_KEY / GEMINI_API_KEY)
 */

type ProviderName = 'openrouter' | 'mistral' | 'gemini';

type ProviderStatus = { configured: boolean; masked?: string };

function mask(key?: string): string | undefined {
  if (!key) return undefined;
  return key.length <= 4 ? '••••' : `••••${key.slice(-4)}`;
}

function emptyStatus(): Record<ProviderName, ProviderStatus> {
  return {
    openrouter: { configured: false },
    mistral: { configured: false },
    gemini: { configured: false },
  };
}

async function statusFor(ctx: QueryCtx, clerkId: string): Promise<Record<ProviderName, ProviderStatus>> {
  const row = await ctx.db
    .query('providerSettings')
    .withIndex('by_clerkId', (q) => q.eq('clerkId', clerkId))
    .first();
  if (!row) return emptyStatus();
  return {
    openrouter: { configured: Boolean(row.openrouterApiKey), masked: mask(row.openrouterApiKey) },
    mistral: { configured: Boolean(row.mistralApiKey), masked: mask(row.mistralApiKey) },
    gemini: { configured: Boolean(row.geminiApiKey), masked: mask(row.geminiApiKey) },
  };
}

/**
 * Masked provider-key status for the Settings UI. Pass the Clerk user id
 * (matching the sessions.list convention: `{ createdBy: user.id }`).
 */
export const getProviderSettings = query({
  args: { clerkId: v.optional(v.string()) },
  handler: async (ctx, args) => {
    if (!args.clerkId) return emptyStatus();
    return await statusFor(ctx, args.clerkId);
  },
});

/**
 * Save (or clear) provider keys for the current user.
 *
 * Field semantics:
 *  - undefined  -> leave the stored value untouched
 *  - ""         -> clear (remove) the stored value, falling back to env vars
 *  - "sk-..."   -> replace the stored value
 */
export const saveProviderSettings = mutation({
  args: {
    clerkId: v.string(),
    openrouterApiKey: v.optional(v.string()),
    mistralApiKey: v.optional(v.string()),
    geminiApiKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query('providerSettings')
      .withIndex('by_clerkId', (q) => q.eq('clerkId', args.clerkId))
      .first();

    const setOpenRouter = args.openrouterApiKey !== undefined;
    const openRouterKey = args.openrouterApiKey?.trim();
    const setMistral = args.mistralApiKey !== undefined;
    const mistralKey = args.mistralApiKey?.trim();
    const setGemini = args.geminiApiKey !== undefined;
    const geminiKey = args.geminiApiKey?.trim();

    const updatedAt = Date.now();

    if (existing) {
      await ctx.db.patch(existing._id, {
        ...(setOpenRouter ? { openrouterApiKey: openRouterKey || undefined } : {}),
        ...(setMistral ? { mistralApiKey: mistralKey || undefined } : {}),
        ...(setGemini ? { geminiApiKey: geminiKey || undefined } : {}),
        updatedAt,
      });
    } else {
      await ctx.db.insert('providerSettings', {
        clerkId: args.clerkId,
        ...(setOpenRouter && openRouterKey ? { openrouterApiKey: openRouterKey } : {}),
        ...(setMistral && mistralKey ? { mistralApiKey: mistralKey } : {}),
        ...(setGemini && geminiKey ? { geminiApiKey: geminiKey } : {}),
        updatedAt,
      });
    }

    return await statusFor(ctx, args.clerkId);
  },
});

// INTERNAL: Backend-only query for trusted server-to-server calls (Inngest engine, etc.)
// WARNING: Returns PLAINTEXT API keys — do NOT expose this to client-facing code!
export const getProviderSecretsInternal = query({
  args: { clerkId: v.string() },
  handler: async (ctx, args) => {
    if (!args.clerkId) return {} as Record<ProviderName, string | undefined>;
    const row = await ctx.db
      .query('providerSettings')
      .withIndex('by_clerkId', (q) => q.eq('clerkId', args.clerkId))
      .first();
    if (!row) return {} as Record<ProviderName, string | undefined>;
    return {
      openrouter: row.openrouterApiKey,
      mistral: row.mistralApiKey,
      gemini: row.geminiApiKey,
    };
  },
});