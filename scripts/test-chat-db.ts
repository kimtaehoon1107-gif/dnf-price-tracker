import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pool } from "../src/db.ts";
const c = await pool.connect();
const query = (sql: string, args?: any[]) =>
  c.query(
    sql
      .replaceAll("feedback_", `feedback_qa_${process.pid}_`)
      .replaceAll("chat_", `chat_qa_${process.pid}_`),
    args,
  );
const rpc = async (action: string, data: any) =>
  (await query("SELECT public.chat_request($1,$2) AS result", [action, data]))
    .rows[0].result;
const password = "chat-test-owner",
  adminPassword = "chat-test-admin-password";
const draft = () => ({
  nickname: "테스트",
  body: "<img onerror=alert(1)>",
  tags: ["a".repeat(32)],
  requestId: crypto.randomUUID(),
  password,
});
try {
  await query("BEGIN");
  await query("SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='20s'");
  for (const file of ["feedback", "chat"])
    await query(
      readFileSync(`sql/${file}.sql`, "utf8").replace(/^BEGIN;|^COMMIT;/gm, ""),
    );
  await query(
    "INSERT INTO feedback_private.admin VALUES(true,extensions.crypt($1,extensions.gen_salt('bf',10)))",
    [adminPassword],
  );
  for (const role of ["anon", "authenticated"]) {
    const p = (
      await query(
        "SELECT has_table_privilege($1,'public.chat_posts','SELECT') AS read, has_function_privilege($1,'public.chat_request(text,jsonb)','EXECUTE') AS rpc, has_schema_privilege($1,'chat_private','USAGE') AS secret",
        [role],
      )
    ).rows[0];
    assert.deepEqual(p, { read: false, rpc: false, secret: false });
  }
  await query("SET LOCAL ROLE service_role");
  const d = draft(),
    root = await rpc("chat-create", d);
  assert(root.id);
  assert.equal(
    (await rpc("chat-create", d)).id,
    root.id,
    "재시도 시 중복 등록하지 않는다",
  );
  assert.equal(
    (await rpc("chat-create", { ...d, password: "another-owner" })).status,
    409,
  );
  const reply = await rpc("chat-create", {
    ...draft(),
    parent: root.id,
    tags: ["b".repeat(32)],
  });
  assert(reply.id);
  assert.equal(
    (await rpc("chat-create", { ...draft(), parent: reply.id })).status,
    404,
  );
  const list = await rpc("chat-list", { tag: "b".repeat(32) });
  assert.equal(list.posts[0].id, root.id);
  assert.equal(list.posts[0].replies.length, 1);
  assert(!JSON.stringify(list).includes("password"));
  assert(!JSON.stringify(list).includes("request_id"));
  assert.equal(
    (await rpc("chat-delete", { id: root.id, password: "wrong-password" }))
      .status,
    401,
  );
  assert.equal(
    (
      await rpc("chat-moderate", {
        id: root.id,
        adminPassword: "wrong-password",
        hidden: true,
      })
    ).status,
    401,
  );
  await rpc("chat-moderate", { id: root.id, adminPassword, hidden: true });
  assert.equal((await rpc("chat-list", {})).posts.length, 0);
  assert.equal(
    (await rpc("chat-create", { ...draft(), parent: root.id })).status,
    404,
  );
  assert.equal(
    (await rpc("chat-list", { admin: true, adminPassword })).posts.length,
    1,
  );
  await rpc("chat-moderate", { id: root.id, adminPassword, hidden: false });
  await rpc("chat-delete", { id: root.id, password });
  const deleted = (await rpc("chat-list", {})).posts[0];
  assert.equal(deleted.body, "");
  assert(deleted.deleted);
  assert.equal(deleted.replies.length, 1);
  console.log(
    "채팅 DB 권한·소유권·중복 방지·답글·태그·숨김·삭제 검증 통과 (롤백)",
  );
} finally {
  await c.query("ROLLBACK");
  c.release();
  await pool.end();
}
