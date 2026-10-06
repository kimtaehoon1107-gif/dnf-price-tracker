import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { pool } from "../src/db.ts";
import { createHandler } from "../supabase/functions/feedback/index.ts";
const connection = await pool.connect();
const query = (sql: string, args?: any[]) =>
  connection.query(
    sql
      .replaceAll("feedback_", `feedback_preview_${process.pid}_`)
      .replaceAll("chat_", `chat_preview_${process.pid}_`),
    args,
  );
await query("BEGIN");
await query("SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='20s'");
for (const name of ["feedback", "chat"])
  await query(
    (await readFile(`sql/${name}.sql`, "utf8")).replace(
      /^BEGIN;|^COMMIT;/gm,
      "",
    ),
  );
let pending = Promise.resolve<any>(undefined);
const rpc = (name: string, data: any) => {
  const task = pending.then(async () => {
    await query("SAVEPOINT request");
    try {
      const result =
        name === "feedback_rate_limit"
          ? await query("SELECT public.feedback_rate_limit($1) AS result", [
              JSON.stringify(data.p_rules),
            ])
          : await query(`SELECT public.${name}($1,$2) AS result`, [
              data.p_action,
              data.p_data,
            ]);
      await query("RELEASE SAVEPOINT request");
      return result.rows[0].result;
    } catch {
      await query("ROLLBACK TO SAVEPOINT request");
      throw Error("테스트 요청 실패");
    }
  });
  pending = task.catch(() => {});
  return task;
};
const origin = "http://127.0.0.1:4203",
  handler = createHandler(rpc, "local-preview-only", origin),
  root = resolve("web");
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", origin);
    if (url.pathname === "/api/feedback") {
      let body = "";
      for await (const chunk of req) {
        body += chunk;
        if (Buffer.byteLength(body) > 24000) {
          res.writeHead(413);
          return res.end("{}");
        }
      }
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers))
        if (v) headers.set(k, Array.isArray(v) ? v.join(",") : v);
      const reply = await handler(
        new Request(origin + url.pathname, {
          method: req.method,
          headers,
          body: req.method === "POST" ? body : undefined,
        }),
      );
      res.writeHead(reply.status, Object.fromEntries(reply.headers));
      return res.end(await reply.text());
    }
    if (req.method !== "GET") {
      res.writeHead(405);
      return res.end();
    }
    if (url.pathname.startsWith("/data/")) {
      const r = await fetch(
        "https://kimtaehoon1107-gif.github.io/dnf-price-tracker" + url.pathname,
      );
      res.writeHead(r.status, {
        "Content-Type": r.headers.get("content-type") || "application/json",
      });
      return res.end(Buffer.from(await r.arrayBuffer()));
    }
    const name = url.pathname === "/" ? "index.html" : url.pathname.slice(1),
      file = resolve(root, name);
    if (!file.startsWith(root + sep)) {
      res.writeHead(403);
      return res.end();
    }
    let body = await readFile(file, "utf8");
    if (name === "chat.js")
      body = body.replace(
        "https://ejtjwtlehkzuutqgzevu.supabase.co/functions/v1/feedback",
        "/api/feedback",
      );
    if (name === "index.html")
      body = body.replace(
        "<body>",
        '<body><p style="padding:10px;background:#fff4da">격리 DB 테스트 · 댓글은 종료 시 삭제됩니다. 운영 댓글이 아닙니다.</p>',
      );
    res.writeHead(200, {
      "Content-Type": name.endsWith(".js")
        ? "text/javascript"
        : name.endsWith(".css")
          ? "text/css"
          : "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end();
  }
});
server.listen(4203, "127.0.0.1", () => console.log(origin));
async function stop() {
  server.close();
  await pending;
  await connection.query("ROLLBACK");
  connection.release();
  await pool.end();
}
process.on("SIGINT", () => stop().then(() => process.exit(0)));
process.on("SIGTERM", () => stop().then(() => process.exit(0)));
