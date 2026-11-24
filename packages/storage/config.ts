import { z } from "zod";

const bool = z.enum(["true", "false", "1", "0"]).transform((v) => v === "true" || v === "1");

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  APP_ENCRYPTION_KEY: z.string().min(1, "APP_ENCRYPTION_KEY fehlt (32 Byte, base64)"),
  HOST: z.string().default("127.0.0.1"),
  PORT: z.coerce.number().int().positive().default(3000),
  PUBLIC_BASE_URL: z.string().url().default("http://localhost:3000"),
  SECURE_COOKIES: bool.default(false),
  AI_PROVIDER: z.enum(["claude", "rules"]).default("rules"),
  ANTHROPIC_API_KEY: z.string().optional(),
  CLAUDE_MODEL: z.string().default("claude-opus-5-5"),
  CLAUDE_EFFORT: z.enum(["low", "medium", "high", "xhigh", "max"]).default("medium"),
  CLAUDE_MAX_TOKENS: z.coerce.number().int().positive().default(16000),
  CLAUDE_REFUSAL_FALLBACK: z.enum(["default", "off"]).default("default"),
  SEND_MODE: z.enum(["drafts_only", "enabled"]).default("drafts_only"),
  DEMO_MODE: bool.default(false),
  ALLOW_TEST_ENDPOINTS: bool.default(false),
  WORKER_POLL_MS: z.coerce.number().int().positive().default(1000),
  MAIL_SYNC_INTERVAL_SEC: z.coerce.number().int().positive().default(60),
  APPROVAL_TTL_MIN: z.coerce.number().int().positive().default(240),
  // Folder with theme.json plus logo and font files for this installation's look (optional).
  THEME_DIR: z.string().optional(),
  // eBay Marketplace Account Deletion: the verification token entered in the eBay developer portal (32–80 of A-Z a-z 0-9 _ -).
  EBAY_DELETION_VERIFICATION_TOKEN: z.string().regex(/^[A-Za-z0-9_-]{32,80}$/, "32–80 Zeichen, nur Buchstaben, Ziffern, _ und -").optional(),
  // eBay keyset of this installation's operator (production App ID, Cert ID, RuName).
  // Set all three and merchants only click "Bei eBay anmelden"; without them every
  // merchant enters an own keyset in the settings.
  EBAY_CLIENT_ID: z.string().trim().min(1).optional(),
  EBAY_CLIENT_SECRET: z.string().trim().min(1).optional(),
  EBAY_RU_NAME: z.string().trim().min(1).optional(),
  // Amazon SP-API app of this installation's operator (Solution Provider Portal: app ID,
  // LWA client ID and secret). Set all three and merchants only click "Bei Amazon
  // anmelden"; without them every merchant enters an own app in the settings.
  AMAZON_SP_APP_ID: z.string().trim().min(1).optional(),
  AMAZON_SP_CLIENT_ID: z.string().trim().min(1).optional(),
  AMAZON_SP_CLIENT_SECRET: z.string().trim().min(1).optional(),
  // true while the app is still a draft at Amazon (consent then carries version=beta).
  AMAZON_SP_APP_DRAFT: bool.default(false),
  // Redirect URI as registered in the app, when it is a forwarding address that sends the
  // browser on to ${PUBLIC_BASE_URL}/oauth/amazon/callback (query kept). Default: that callback.
  AMAZON_SP_REDIRECT_URI: z.string().url().startsWith("https://").optional(),
});

export type AppConfig = z.infer<typeof schema>;

/** Read configuration from the environment. Secrets never come from the browser. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `- ${i.path.join(".")}: ${i.message}`);
    throw new Error(`Ungültige Konfiguration:\n${lines.join("\n")}`);
  }
  const config = parsed.data;
  const ebay = [config.EBAY_CLIENT_ID, config.EBAY_CLIENT_SECRET, config.EBAY_RU_NAME].filter(Boolean).length;
  if (ebay !== 0 && ebay !== 3) throw new Error("eBay-Zugang der Installation unvollständig: EBAY_CLIENT_ID, EBAY_CLIENT_SECRET und EBAY_RU_NAME gehören zusammen.");
  const amazon = [config.AMAZON_SP_APP_ID, config.AMAZON_SP_CLIENT_ID, config.AMAZON_SP_CLIENT_SECRET].filter(Boolean).length;
  if (amazon !== 0 && amazon !== 3) throw new Error("Amazon-Zugang der Installation unvollständig: AMAZON_SP_APP_ID, AMAZON_SP_CLIENT_ID und AMAZON_SP_CLIENT_SECRET gehören zusammen.");
  if (config.AI_PROVIDER === "claude" && !config.ANTHROPIC_API_KEY) {
    throw new Error("AI_PROVIDER=claude benötigt ANTHROPIC_API_KEY.");
  }
  return config;
}

/** The operator's eBay keyset, or null when merchants bring their own. Server only, never sent to the browser. */
export function operatorEbayApp(config: Pick<AppConfig, "EBAY_CLIENT_ID" | "EBAY_CLIENT_SECRET" | "EBAY_RU_NAME">): { clientId: string; clientSecret: string; ruName: string } | null {
  if (!config.EBAY_CLIENT_ID || !config.EBAY_CLIENT_SECRET || !config.EBAY_RU_NAME) return null;
  return { clientId: config.EBAY_CLIENT_ID, clientSecret: config.EBAY_CLIENT_SECRET, ruName: config.EBAY_RU_NAME };
}

/** The operator's Amazon SP-API app, or null when merchants bring their own. Server only, never sent to the browser. */
export function operatorAmazonApp(config: Pick<AppConfig, "AMAZON_SP_APP_ID" | "AMAZON_SP_CLIENT_ID" | "AMAZON_SP_CLIENT_SECRET" | "AMAZON_SP_APP_DRAFT">): { appId: string; clientId: string; clientSecret: string; draft: boolean } | null {
  if (!config.AMAZON_SP_APP_ID || !config.AMAZON_SP_CLIENT_ID || !config.AMAZON_SP_CLIENT_SECRET) return null;
  return { appId: config.AMAZON_SP_APP_ID, clientId: config.AMAZON_SP_CLIENT_ID, clientSecret: config.AMAZON_SP_CLIENT_SECRET, draft: config.AMAZON_SP_APP_DRAFT };
}
