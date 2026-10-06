export function validateChat(input: any) {
  const action = input.action,
    d = input.data;
  if (
    !["chat-list", "chat-create", "chat-delete", "chat-moderate"].includes(
      action,
    ) ||
    !d ||
    typeof d !== "object" ||
    Array.isArray(d) ||
    d.website
  )
    throw new Error("요청 형식을 확인해 주세요.");
  const data: Record<string, any> = {};
  const text = (key: string, min: number, max: number) => {
    if (
      typeof d[key] !== "string" ||
      [...d[key].trim()].length < min ||
      [...d[key]].length > max ||
      /[\u0000-\u001f]/.test(d[key].replace(/\n/g, ""))
    )
      throw new Error("입력 길이 또는 문자를 확인해 주세요.");
    data[key] = d[key].trim();
  };
  const id = (key: string) => {
    if (!Number.isSafeInteger(d[key]) || d[key] < 1)
      throw new Error("글 번호를 확인해 주세요.");
    data[key] = d[key];
  };
  const tag = (v: unknown) =>
    typeof v === "string" &&
    /^(?:[a-f0-9]{32}(?::max)?|legendary-card)$/.test(v);
  if (action === "chat-list") {
    if (d.before != null) id("before");
    if (d.tag != null) {
      if (!tag(d.tag)) throw new Error("아이템 태그를 확인해 주세요.");
      data.tag = d.tag;
    }
  }
  if (action === "chat-create") {
    text("nickname", 1, 20);
    text("body", 1, 200);
    if (/^(관리자|운영자|admin)$/i.test(data.nickname.replace(/\s/g, "")))
      throw new Error("다른 닉네임을 사용해 주세요.");
    if (!Array.isArray(d.tags) || d.tags.length > 5 || !d.tags.every(tag))
      throw new Error("태그는 최대 5개입니다.");
    data.tags = [...new Set(d.tags)];
    if (d.parent != null) id("parent");
    if (
      typeof d.requestId !== "string" ||
      !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(d.requestId)
    )
      throw new Error("등록 정보를 확인해 주세요.");
    data.requestId = d.requestId;
  }
  if (["chat-create", "chat-delete"].includes(action)) {
    text("password", 8, 72);
    data.password = d.password;
    if (new TextEncoder().encode(d.password).length > 72)
      throw new Error("관리키가 너무 깁니다.");
  }
  if (["chat-delete", "chat-moderate"].includes(action)) id("id");
  if (d.admin === true || action === "chat-moderate") {
    text("adminPassword", 12, 72);
    data.adminPassword = d.adminPassword;
    data.admin = true;
    if (new TextEncoder().encode(d.adminPassword).length > 72)
      throw new Error("관리자 비밀번호가 너무 깁니다.");
  }
  if (action === "chat-moderate") {
    if (typeof d.hidden !== "boolean")
      throw new Error("숨김 상태를 확인해 주세요.");
    data.hidden = d.hidden;
  }
  return { action, data };
}
