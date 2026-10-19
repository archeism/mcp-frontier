import { Webhook } from "standardwebhooks";
import { z } from "zod/v4";
import { createJsonSchemaValidator } from "./json-schema-validator.ts";

const cursor = z.string().nullable().optional();
const record = z.record(z.string(), z.unknown());
const verification = z.object({ type: z.literal("verification"), challenge: z.string().min(1).max(8192) });
const event = z.object({ eventId: z.string().min(1).max(1024), name: z.string().min(1).max(256),
  timestamp: z.iso.datetime({ offset: true }), data: record, cursor, _meta: record.optional() }).passthrough();
const control = z.discriminatedUnion("type", [
  z.object({ type: z.literal("gap"), cursor: z.string().nullable().default(null) }).passthrough(),
  z.object({ type: z.literal("terminated"), error: z.object({ code: z.number().int(), message: z.string(), data: z.unknown().optional() }) }).passthrough(),
]);
export type WebhookDelivery = z.infer<typeof event> | z.infer<typeof control>;
export interface WebhookRouteOptions {
  path: string;
  secret: string;
  name: string;
  payloadSchema: Record<string, unknown>;
  /** Atomically deduplicate (subscription + deliveryId) and durably accept/forward.
   * Resolve for already-accepted retries; throw to request redelivery. */
  accept(delivery: WebhookDelivery, deliveryId: string): Promise<void>;
}
export function validateWebhookSecret(secret: unknown): asserts secret is string {
  const key = typeof secret === "string" && secret.startsWith("whsec_") ? secret.slice(6) : "";
  const decoded = Buffer.from(key, "base64");
  if (decoded.length < 24 || decoded.length > 64 || decoded.toString("base64") !== key)
    throw new Error("Webhook secret must be whsec_ plus base64 of 24–64 random bytes");
}
function verifier(secret: string): Webhook {
  validateWebhookSecret(secret);
  return new Webhook(secret);
}

/** HTTP receiver boundary; TLS may terminate at the operator's reverse proxy. */
export class WebhookReceiver {
  private routes = new Map<string, {
    options: WebhookRouteOptions; verifiers: Webhook[]; subscriptionId: string | undefined;
    validate: ReturnType<ReturnType<typeof createJsonSchemaValidator>["getValidator"]>;
  }>();
  register(options: WebhookRouteOptions) {
    const initialVerifier = verifier(options.secret);
    if (!options.path.startsWith("/") || options.path.includes("?") || options.path.includes("#") || this.routes.has(options.path))
      throw new Error("Invalid or duplicate webhook receiver path");
    const route = { options, verifiers: [initialVerifier],
      validate: createJsonSchemaValidator().getValidator(options.payloadSchema), subscriptionId: undefined as string | undefined };
    this.routes.set(options.path, route);
    return {
      activate: (id: string) => { if (!id || id.length > 8192) throw new Error("Invalid webhook subscription id"); route.subscriptionId = id; },
      updateSecrets: (secrets: string[]) => {
        if (this.routes.get(options.path) !== route) throw new Error("Webhook route is closed");
        if (!secrets.length || secrets.length > 2) throw new Error("Invalid webhook key count");
        route.verifiers = secrets.map(verifier);
      },
      updatePayloadSchema: (schema: Record<string, unknown>) => {
        if (this.routes.get(options.path) !== route) throw new Error("Webhook route is closed");
        route.validate = createJsonSchemaValidator().getValidator(schema);
      },
      close: () => { if (this.routes.get(options.path) === route) this.routes.delete(options.path); },
    };
  }
  async handle(request: Request): Promise<Response> {
    const route = this.routes.get(new URL(request.url).pathname);
    if (!route) return new Response(null, { status: 404 });
    if (request.method !== "POST") return new Response(null, { status: 405, headers: { allow: "POST" } });
    if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json")
      return new Response(null, { status: 415 });
    const subscriptionId = request.headers.get("x-mcp-subscription-id");
    if (!subscriptionId) return new Response(null, { status: 400 });
    const timestamp = request.headers.get("webhook-timestamp") ?? "";
    if (!/^(0|[1-9][0-9]*)$/.test(timestamp) || !Number.isSafeInteger(Number(timestamp)))
      return new Response(null, { status: 401 });
    if (route.subscriptionId && subscriptionId !== route.subscriptionId) return new Response(null, { status: 403 });
    // Bound the actual streamed bytes, not just the caller-controlled Content-Length.
    const reader = request.body?.getReader();
    if (!reader) return new Response(null, { status: 400 });
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > 256 * 1024) { await reader.cancel(); return new Response(null, { status: 413 }); }
        chunks.push(value);
      }
    } catch { return new Response(null, { status: 400 }); }
    if (this.routes.get(new URL(request.url).pathname) !== route) return new Response(null, { status: 404 });
    const raw = Buffer.concat(chunks);
    // standardwebhooks hashes Buffer.toString(); reject non-roundtrippable UTF-8
    // so its string-based implementation still authenticates the exact wire bytes.
    try { new TextDecoder("utf-8", { fatal: true }).decode(raw); }
    catch { return new Response(null, { status: 400 }); }
    if (!route.verifiers.some(key => {
      try { key.verify(raw, Object.fromEntries(request.headers), { jsonParse: false }); return true; }
      catch { return false; }
    })) return new Response(null, { status: 401 });
    let body: unknown;
    try { body = JSON.parse(raw.toString("utf8")); } catch { return new Response(null, { status: 400 }); }
    const challenge = verification.safeParse(body);
    if (challenge.success) return Response.json({ challenge: challenge.data.challenge });
    if (!route.subscriptionId) return new Response(null, { status: 425 });
    const isControl = body !== null && typeof body === "object" && "type" in body;
    const parsed = isControl ? control.safeParse(body) : event.safeParse(body);
    if (!parsed.success) return new Response(null, { status: 400 });
    const delivery = parsed.data;
    const id = request.headers.get("webhook-id")!;
    if (!("type" in delivery) && (delivery.eventId !== id || delivery.name !== route.options.name || !route.validate(delivery.data).valid))
      return new Response(null, { status: 400 });
    try { await route.options.accept(delivery, id); }
    catch { return new Response(null, { status: 503 }); }
    return new Response(null, { status: 202 });
  }
}
