// api/shopify-sync holds the service-role key and the Shopify admin token, so it must refuse anyone
// who isn't a signed-in admin (added 2026-10-19; before, anyone knowing a club UUID could trigger it).
// This runs the real handler against a local stand-in for Supabase (no live data, no Shopify:
// the Shopify domain points at a closed local port and the "allowed" case stops at the club's
// product-mapping lookup, which the stand-in answers with an empty list).
// Run with: npx tsx scripts/test-shopify-sync-auth.ts
import http from "node:http";
import type { AddressInfo } from "node:net";

const ADMIN_TOKEN = "token-admin";
const ADMIN_ID = "00000000-0000-0000-0000-0000000000aa";
const STAFF_TOKEN = "token-signed-in-but-not-admin";
const STAFF_ID = "00000000-0000-0000-0000-0000000000bb";
const CLUB_ID = "11111111-1111-1111-1111-111111111111";

let failures = 0;
function check(label: string, condition: boolean) {
  console.log(`${condition ? "PASS" : "FAIL"} - ${label}`);
  if (!condition) failures++;
}

const tablesRead: string[] = [];

const stub = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://stub");
  const send = (status: number, body: unknown) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };

  if (url.pathname === "/auth/v1/user") {
    const bearer = String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
    const id = bearer === ADMIN_TOKEN ? ADMIN_ID : bearer === STAFF_TOKEN ? STAFF_ID : null;
    if (!id) return send(401, { code: 401, msg: "invalid JWT" });
    return send(200, { id, aud: "authenticated", role: "authenticated", email: `${id}@example.test` });
  }

  const table = url.pathname.replace("/rest/v1/", "");
  tablesRead.push(table);
  const singular = String(req.headers.accept ?? "").includes("vnd.pgrst.object");
  let rows: object[] = [];
  if (table === "admin_users" && url.searchParams.get("user_id") === `eq.${ADMIN_ID}`) {
    rows = [{ user_id: ADMIN_ID }];
  }
  if (singular) {
    return rows.length
      ? send(200, rows[0])
      : send(406, { code: "PGRST116", message: "no rows", details: "", hint: "" });
  }
  return send(200, rows);
});

interface Reply { status: number; body: any }

async function call(
  handler: (req: any, res: any) => Promise<unknown>,
  opts: { method?: string; authorization?: string; body?: unknown },
): Promise<Reply> {
  const reply: Reply = { status: 0, body: undefined };
  const res = {
    status(code: number) { reply.status = code; return res; },
    json(body: unknown) { reply.body = body; return res; },
    setHeader() { return res; },
  };
  const headers: Record<string, string> = {};
  if (opts.authorization !== undefined) headers.authorization = opts.authorization;
  await handler({ method: opts.method ?? "POST", headers, body: opts.body }, res);
  return reply;
}

async function main() {
  await new Promise<void>((resolve) => stub.listen(0, "127.0.0.1", resolve));
  const port = (stub.address() as AddressInfo).port;
  process.env.SUPABASE_URL = `http://127.0.0.1:${port}`;
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key-for-test";
  process.env.SHOPIFY_ADMIN_TOKEN = "shpat_test";
  process.env.SHOPIFY_STORE_DOMAIN = "127.0.0.1:1"; // nothing listens here

  const { default: handler } = await import("../api/shopify-sync");
  const body = { clubId: CLUB_ID };
  const touchedMappings = () => tablesRead.includes("shopify_product_club_map") || tablesRead.includes("inventory");

  let r = await call(handler, { body });
  check("no Authorization header -> 401", r.status === 401);
  check("  ...and nothing was read for the club", !touchedMappings());

  r = await call(handler, { authorization: "Bearer", body });
  check("empty bearer token -> 401", r.status === 401);

  r = await call(handler, { authorization: "Bearer not-a-real-token", body });
  check("invalid token -> 401", r.status === 401);
  check("  ...and nothing was read for the club", !touchedMappings());

  r = await call(handler, { authorization: `Bearer ${STAFF_TOKEN}`, body });
  check("valid user who is not in admin_users -> 403", r.status === 403);
  check("  ...and nothing was read for the club", !touchedMappings());

  r = await call(handler, { authorization: `Bearer ${ADMIN_TOKEN}`, body: {} });
  check("admin without a clubId -> 400", r.status === 400);

  r = await call(handler, { authorization: `Bearer ${ADMIN_TOKEN}`, body });
  check("admin with a clubId gets past auth (stops at 'no products mapped' -> 404)", r.status === 404);
  check("  ...and the mapping lookup did run", tablesRead.includes("shopify_product_club_map"));

  r = await call(handler, { method: "GET", body });
  check("GET -> 405", r.status === 405);

  stub.close();
  console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
  stub.closeAllConnections();
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((e) => {
  console.error(e);
  stub.close();
  process.exit(1);
});
