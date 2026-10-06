import assert from "node:assert/strict";
import {
  validate,
  rateRules,
  createHandler,
} from "../supabase/functions/feedback/index.ts";
const data = {
  nickname: "모험가",
  body: "@에픽 소울 결정",
  tags: ["a".repeat(32)],
  requestId: crypto.randomUUID(),
  password: "test-owner-password",
};
assert.equal(
  validate({ action: "chat-create", data: { ...data, hidden: true } }).data
    .hidden,
  undefined,
);
assert.throws(() =>
  validate({ action: "chat-create", data: { ...data, body: "x".repeat(201) } }),
);
assert.throws(() =>
  validate({ action: "chat-create", data: { ...data, tags: ["<script>"] } }),
);
assert.throws(() =>
  validate({ action: "chat-create", data: { ...data, parent: -1 } }),
);
assert.throws(() =>
  validate({ action: "chat-create", data: { ...data, nickname: "관리자" } }),
);
assert.throws(() =>
  validate({ action: "chat-moderate", data: { id: 1, hidden: true } }),
);
assert(rateRules("chat-create", data, "actor").some((r) => r.limit === 6));
assert(
  rateRules("chat-delete", { id: 1 }, "actor").some(
    (r) => r.key === "chat-owner:1",
  ),
);
const calls: string[] = [];
const handler = createHandler(async (name) => {
  calls.push(name);
  return name === "feedback_rate_limit" ? true : { posts: [] };
}, "test-secret");
const response = await handler(
  new Request("https://example.com", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "chat-list", data: {} }),
  }),
);
assert.equal(response.status, 200);
assert.deepEqual(calls, ["feedback_rate_limit", "chat_request"]);
console.log("채팅 입력 길이·태그·관리 권한·횟수 제한·RPC 분리 통과");
