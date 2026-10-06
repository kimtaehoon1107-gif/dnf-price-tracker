(async () => {
  const summary = await fetch("data/summary.json").then((r) => {
    if (!r.ok) throw Error("아이템 목록을 불러오지 못했습니다.");
    return r.json();
  });
  const items = summary.items.flatMap((i) =>
    i.category === "카드"
      ? [
          { id: i.item_id, name: i.item_name + " · 미업글", hash: i.item_id },
          {
            id: i.item_id + ":max",
            name: i.item_name + " · 풀업",
            hash: i.item_id,
          },
        ]
      : [{ id: i.item_id, name: i.item_name, hash: i.item_id }],
  );
  items.push({
    id: "legendary-card",
    name: "레전더리 카드 P10",
    hash: "legendary-card",
  });
  let scope = null,
    reply = null,
    mentions = [],
    matches = [],
    active = 0,
    query = null,
    composing = false;
  let rows = [];

  const endpoint =
    "https://ejtjwtlehkzuutqgzevu.supabase.co/functions/v1/feedback";
  let viewingOlder = false,
    loaded = false,
    busy = false,
    generation = 0,
    nextCursor = null,
    adminPassword = "",
    adminUntil = 0,
    pending = null;
  let owners = {};
  try {
    owners = JSON.parse(localStorage.getItem("market-chat-owners") || "{}");
  } catch {}
  const date = (v) =>
    v
      ? new Date(v).toLocaleString("ko-KR", {
          timeZone: "Asia/Seoul",
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
        })
      : "";
  async function api(action, data = {}) {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, data }),
      credentials: "omit",
      cache: "no-store",
      signal: AbortSignal.timeout(20000),
    });
    const result = await response.json();
    if (!response.ok)
      throw Error(result.error || "잠시 후 다시 시도해 주세요.");
    return result;
  }
  function admin() {
    if (Date.now() > adminUntil) adminPassword = "";
    return adminPassword ? { admin: true, adminPassword } : {};
  }
  function mapped(p) {
    return {
      ...p,
      nick: p.nickname,
      text: p.body,
      replies: (p.replies || []).map(mapped),
    };
  }
  async function load(reset = false, older = false) {
    const turn = ++generation;
    if (reset) {
      viewingOlder = false;
      rows = [];
      loaded = false;
      nextCursor = null;
      unread = 0;
      updateUnread();
      render();
    }
    try {
      const d = await api("chat-list", {
        ...admin(),
        ...(scope ? { tag: scope } : {}),
        ...(older && nextCursor ? { before: nextCursor } : {}),
      });
      if (turn !== generation) return;
      const incoming = d.posts.slice(0, 20).map(mapped);
      const known = new Set(
        rows.flatMap((r) => [r.id, ...r.replies.map((v) => v.id)]),
      );
      const added = incoming
        .flatMap((r) => [r.id, ...r.replies.map((v) => v.id)])
        .filter((id) => !known.has(id)).length;
      if (loaded && !older) {
        unread += added;
        updateUnread();
      }
      if (older) {
        viewingOlder = true;
        rows = [...rows, ...incoming.filter((r) => !known.has(r.id))];
      } else rows = incoming;
      nextCursor = d.posts.length > 20 ? incoming.at(-1).id : null;
      loaded = true;
      const list = q("#cd-list"),
        top = list.scrollTop;
      render();
      list.scrollTop = top;
      more.hidden = !nextCursor;
      q("#cd-notice").textContent = "";
    } catch (e) {
      if (turn === generation)
        q("#cd-notice").textContent = "연결을 확인해 주세요. " + e.message;
    }
  }
  async function tick() {
    if (!document.hidden && !busy && !viewingOlder) await load();
    setTimeout(tick, panel.classList.contains("cd-closed") ? 60000 : 30000);
  }
  function manage(el, p) {
    if (p.hidden) el.append(node("span", " · 관리자 숨김", "cd-small"));
    if (!p.deleted && owners[p.id])
      el.append(
        button("삭제", () => {
          showDialog("이 댓글을 삭제할까요?", false, async () => {
            await api("chat-delete", { id: p.id, password: owners[p.id] });
            delete owners[p.id];
            localStorage.setItem("market-chat-owners", JSON.stringify(owners));
            await load();
          });
        }),
      );
    if (adminPassword)
      el.append(
        button(p.hidden ? "공개" : "숨김", () =>
          showDialog("이 댓글의 공개 상태를 바꿀까요?", false, async () => {
            await api("chat-moderate", {
              id: p.id,
              hidden: !p.hidden,
              ...admin(),
            });
            await load();
          }),
        ),
      );
  }
  const style = document.createElement("style");
  style.textContent = `
body{transition:padding-right 220ms ease}body.market-chat-open{padding-right:370px}#cd-panel{position:fixed;right:16px;top:82px;bottom:18px;width:338px;z-index:200;background:#fff;color:#18314c;border:1px solid #dde5ee;border-radius:16px;box-shadow:0 10px 32px #18314c18;display:flex;flex-direction:column;font:14px/1.5 system-ui,sans-serif}#cd-panel{transition:transform 220ms ease,opacity 220ms ease,visibility 220ms;transform:translateX(0);opacity:1;visibility:visible}#cd-panel.cd-closed{transform:translateX(24px);opacity:0;visibility:hidden;pointer-events:none}#cd-panel *{box-sizing:border-box}#cd-panel[hidden],#cd-launch[hidden],#cd-panel [hidden]{display:none!important}#cd-panel header{position:static;padding:16px;border-bottom:1px solid #e3e9f0;display:block;height:auto;background:white}#cd-panel .cd-row{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap}#cd-panel button,#cd-launch{font:inherit;padding:7px 10px;border:1px solid #dce4ef;border-radius:8px;color:#234664;background:white;cursor:pointer}#cd-panel button[aria-pressed=true],#cd-panel .cd-send,#cd-launch{background:#1765cc;color:white;border-color:#1765cc}#cd-panel .cd-small{font-size:12px;color:#65788d}#cd-panel .cd-tabs{display:flex;gap:6px;margin-top:12px}#cd-list{flex:1;overflow:auto;padding:0 16px;min-height:90px}#cd-list article{padding:14px 0;border-bottom:1px solid #e4eaf1;overflow-wrap:anywhere}#cd-list p{margin:7px 0}#cd-panel .cd-link{border:0;padding:3px 0;color:#1765cc;background:transparent;font-size:12px;text-align:left}#cd-panel .cd-reply{border-left:2px solid #d7e4f4;padding:7px 10px;margin-top:8px;background:#f5f8fc}#cd-form{border-top:1px solid #e1e7ef;padding:14px 16px;background:#f6f8fc;border-radius:0 0 16px 16px;max-height:60%;overflow:auto}#cd-panel input,#cd-panel textarea{width:100%;border:1px solid #d9e3ef;background:#fff;color:#18314c;padding:9px;border-radius:8px;font:14px system-ui;min-width:0}#cd-panel textarea{min-height:64px;resize:vertical;margin:8px 0}#cd-picker{margin:8px 0;padding:10px;background:#fff;border:1px solid #dbe3ed;border-radius:8px}#cd-results{max-height:170px;overflow:auto;display:grid;gap:4px;margin-top:7px}#cd-results button{text-align:left;font-size:12px}#cd-launch{position:fixed;bottom:20px;right:20px;z-index:201;box-shadow:0 5px 20px #172b4d22;font:14px system-ui}#cd-notice{font-size:12px;color:#586d86;margin-top:5px}#cd-panel .cd-tag-label{overflow-wrap:anywhere;max-width:100%}
@media(max-width:1150px){body.market-chat-open{padding-right:0}#cd-panel{width:min(370px,calc(100vw - 24px));top:95px;bottom:14px;right:12px}}@media(max-width:600px){#cd-panel{top:20%;width:100%;right:0;bottom:0;border-radius:18px 18px 0 0}#cd-panel button{min-height:40px}#cd-panel input,#cd-panel textarea{font-size:16px}#cd-panel.cd-closed{transform:translateY(24px)}}@media(prefers-reduced-motion:reduce){body,#cd-panel{transition:none}}
`;
  style.textContent += `
/* 화면 오른쪽 레일에서 펼치는 커뮤니티 패널 */
body{padding-right:56px}body.market-chat-open{padding-right:416px}
#cd-rail{position:fixed;inset:0 0 0 auto;width:56px;z-index:202;background:#f5f6f8;border-left:1px solid #e8ebef;display:flex;align-items:center;flex-direction:column;padding-top:16px;gap:18px;color:#8b95a1}
#cd-launch{position:relative;inset:auto;width:40px;height:40px;padding:0;border:0;border-radius:10px;box-shadow:none;background:transparent;color:#8b95a1;font:24px/1 system-ui;cursor:pointer}
#cd-launch:hover,#cd-launch:focus-visible{background:#e8edf3;color:#3182f6}
#cd-rail-chat{position:relative;display:grid;justify-items:center;gap:6px;width:48px;padding:10px 0;border:0;border-radius:10px;background:transparent;color:#8b95a1;font:11px system-ui;cursor:pointer}
#cd-rail-chat svg{width:21px;height:21px}#cd-rail-chat[aria-pressed=true]{color:#3182f6;background:#e8f1ff}
#cd-rail-badge{position:absolute;right:4px;top:1px;min-width:15px;height:15px;padding:0 3px;border-radius:9px;background:#3182f6;color:#fff;font:10px/15px system-ui}#cd-rail-badge[hidden]{display:none}
#cd-panel{right:56px;top:0;bottom:0;width:360px;border:0;border-left:1px solid #e8ebef;border-radius:0;box-shadow:none;background:#fafbfc;color:#333d4b;transform:translateX(0);overflow:hidden}
#cd-panel.cd-closed{transform:translateX(100%)}
#cd-panel header{padding:24px 20px 16px;background:#fafbfc;border-bottom:1px solid #e8ebef}
#cd-panel header strong{font-size:18px;letter-spacing:-.5px}#cd-panel .cd-small{color:#8b95a1}
#cd-panel #cd-close{border:0;background:transparent;color:#8b95a1;font-size:20px;padding:0 6px}
#cd-panel .cd-tabs{background:#f0f2f5;border-radius:10px;padding:3px;gap:3px;margin:20px 0 12px}
#cd-panel .cd-tabs button{flex:1;border:0;background:transparent;color:#8b95a1;font-weight:600}
#cd-panel .cd-tabs button[aria-pressed=true]{background:#fff;color:#333d4b;box-shadow:0 1px 4px #191f2810}
#cd-panel header>.cd-link{margin:12px 16px 0 0;color:#8b95a1}
#cd-list{padding:0 20px}#cd-list article{padding:20px 0;border-color:#edf0f3}#cd-list p{line-height:1.7;color:#4e5968}
#cd-panel .cd-reply{background:#f2f4f6;border-color:#e5e8eb;border-radius:0 8px 8px 0}
#cd-form{padding:18px 20px;background:#fafbfc;border-radius:0;border-color:#e8ebef}
#cd-panel input,#cd-panel textarea{background:#f2f4f6;border-color:transparent;border-radius:10px;color:#333d4b}
#cd-panel input:focus,#cd-panel textarea:focus{outline:2px solid #3182f6;outline-offset:1px}
#cd-panel .cd-send{background:#3182f6;border:0;border-radius:10px;font-weight:600;padding:9px 16px}
@media(max-width:1150px){body.market-chat-open{padding-right:56px}#cd-panel{width:360px;right:56px;top:0;bottom:0;box-shadow:-12px 0 30px #191f280c}}
@media(max-width:600px){body,body.market-chat-open{padding-right:44px}#cd-rail{width:44px;padding-top:10px}#cd-launch{width:36px}#cd-rail-chat{width:40px}#cd-panel{width:calc(100% - 44px);right:44px;top:0;bottom:0;border-radius:0}#cd-panel header{padding:16px}#cd-list{padding:0 16px}#cd-form{padding:14px 16px}#cd-panel.cd-closed{transform:translateX(100%)}}
`;
  document.head.append(style);

  const panel = document.createElement("aside");
  panel.id = "cd-panel";
  panel.setAttribute("aria-label", "시세 이야기");
  panel.innerHTML = `<header><div class="cd-row"><strong>시세 이야기</strong><button type="button" id="cd-close" aria-label="대화 패널 접기">≫</button></div><div class="cd-small">아이템 시세와 사이트 의견을 나눠보세요.</div><div class="cd-tabs"><button type="button" id="cd-all" aria-pressed="true">전체</button><button type="button" id="cd-current" aria-pressed="false">현재 아이템</button></div><div id="cd-context" class="cd-small"></div></header><div id="cd-list"></div><form id="cd-form"><div id="cd-replying" class="cd-small"></div><label class="cd-small" for="cd-nick">닉네임</label><input id="cd-nick" maxlength="20" placeholder="모험가"><textarea id="cd-text" aria-label="이야기 내용" placeholder="이야기를 남겨보세요. @로 아이템 검색" required maxlength="200" aria-controls="cd-results" aria-autocomplete="list" aria-expanded="false"></textarea><div id="cd-picker" hidden><div class="cd-small">아이템 연결 · ↑↓ 선택 / Enter 확인</div><div id="cd-results" role="listbox" aria-label="아이템 검색 후보"></div></div><div class="cd-row"><span class="cd-small">200자 · 태그 최대 5개</span><button class="cd-send" type="submit">등록</button></div><div id="cd-notice" role="status"></div></form>`;
  document.body.append(panel);
  const launch = document.createElement("button");
  launch.id = "cd-launch";
  launch.textContent = "≪";
  launch.setAttribute("aria-label", "시세 이야기 열기");
  launch.setAttribute("aria-controls", "cd-panel");
  const rail = document.createElement("nav");
  rail.id = "cd-rail";
  rail.setAttribute("aria-label", "시세 이야기 사이드바");
  const railChat = document.createElement("button");
  railChat.id = "cd-rail-chat";
  railChat.type = "button";
  railChat.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M20 11.5a8 8 0 0 1-8 8H5l-3 2v-10a9 9 0 0 1 18 0Z"/><path d="M7 10h9M7 14h6"/></svg><span>이야기</span>';
  railChat.setAttribute("aria-label", "시세 이야기 열기");
  railChat.setAttribute("aria-controls", "cd-panel");
  const railBadge = document.createElement("span");
  railBadge.id = "cd-rail-badge";
  railBadge.hidden = true;
  railChat.append(railBadge);
  rail.append(launch, railChat);
  document.body.append(rail);
  const q = (s) => panel.querySelector(s),
    name = (id) => items.find((i) => i.id === id)?.name || "전체 이야기",
    current = () =>
      items.find((i) => i.hash === location.hash.slice(1))?.id || null;
  const node = (t, text, cls) => {
    const e = document.createElement(t);
    e.textContent = text;
    if (cls) e.className = cls;
    return e;
  };
  const button = (text, fn) => {
    const b = node("button", text, "cd-link");
    b.type = "button";
    b.onclick = fn;
    return b;
  };
  const normalize = (s) => s.replace(/\s+/g, "").toLowerCase();
  function hide() {
    query = null;
    matches = [];
    q("#cd-picker").hidden = true;
    q("#cd-text").setAttribute("aria-expanded", "false");
    q("#cd-text").removeAttribute("aria-activedescendant");
  }
  function sync() {
    mentions = mentions.filter((i) =>
      q("#cd-text").value.includes("@" + i.name),
    );
  }
  function cancel() {
    reply = null;
    q("#cd-replying").replaceChildren();
  }
  function body(text, ids) {
    const p = document.createElement("p");
    const linked = items
      .filter((i) => ids.includes(i.id))
      .sort((a, b) => b.name.length - a.name.length);
    let pos = 0;
    while (pos < text.length) {
      let best = null;
      for (const i of linked) {
        const at = text.indexOf("@" + i.name, pos);
        if (at >= 0 && (!best || at < best.at)) best = { i, at };
      }
      if (!best) {
        p.append(document.createTextNode(text.slice(pos)));
        break;
      }
      p.append(
        document.createTextNode(text.slice(pos, best.at)),
        button("@" + best.i.name, () => {
          scope = best.i.id;
          load(true);
        }),
      );
      pos = best.at + best.i.name.length + 1;
    }
    return p;
  }
  function render() {
    q("#cd-all").setAttribute("aria-pressed", String(scope === null));
    q("#cd-current").setAttribute("aria-pressed", String(scope !== null));
    q("#cd-context").textContent = scope
      ? name(scope)
      : "모든 아이템의 이야기를 함께 봅니다";
    const list = q("#cd-list");
    list.replaceChildren();
    const shown = rows.filter(
      (r) =>
        scope === null ||
        r.tag === scope ||
        (r.tags || []).includes(scope) ||
        r.replies.some((v) => (v.tags || []).includes(scope)),
    );
    if (!shown.length)
      list.append(
        node(
          "p",
          loaded
            ? "아직 이야기가 없어요. 첫 한마디를 남겨보세요."
            : "이야기를 불러오는 중입니다…",
          "cd-small",
        ),
      );
    for (const r of shown) {
      const a = document.createElement("article");
      a.append(node("strong", r.nick));
      if (r.tag) {
        a.append(document.createElement("br"));
        a.append(
          button("@" + name(r.tag), () => {
            scope = r.tag;
            load(true);
          }),
          node("span", " · "),
          button("시세 보기 ↗", () => {
            location.hash = items.find((i) => i.id === r.tag).hash;
          }),
        );
      }
      a.append(
        node("div", date(r.created_at), "cd-small"),
        body(r.deleted ? "삭제된 글입니다." : r.text, r.tags || []),
      );
      manage(a, r);
      for (const v of r.replies) {
        const box = node("div", "", "cd-reply");
        box.append(
          node("span", v.nick + " · " + date(v.created_at)),
          body(v.deleted ? "삭제된 답글입니다." : v.text, v.tags || []),
        );
        manage(box, v);
        a.append(box);
      }
      if (!r.deleted && !r.hidden)
        a.append(
          button(
            "답글" + (r.replies.length ? " " + r.replies.length : ""),
            () => {
              reply = r.id;
              q("#cd-replying").replaceChildren(
                node("span", r.nick + "에게 답글 "),
                button("취소", cancel),
              );
              q("#cd-text").focus();
            },
          ),
        );
      list.append(a);
    }
    list.querySelectorAll("button").forEach((b) => {
      const i = items.find((i) => "@" + i.name === b.textContent);
      if (i) decorate(b, i);
    });
  }
  function select(i) {
    if (!query) return;
    if (mentions.length >= 5 && !mentions.some((x) => x.id === i.id)) {
      q("#cd-notice").textContent = "태그는 최대 5개입니다.";
      return;
    }
    const box = q("#cd-text"),
      token = "@" + i.name + " ",
      value =
        box.value.slice(0, query.start) + token + box.value.slice(query.end);
    if (value.length > 200) {
      q("#cd-notice").textContent =
        "아이템 이름을 포함해 200자 이내로 입력해 주세요.";
      return;
    }
    const caret = query.start + token.length;
    box.value = value;
    mentions = mentions.filter((x) => x.id !== i.id);
    mentions.push(i);
    hide();
    box.focus();
    box.setSelectionRange(caret, caret);
    sync();
    saveDraft();
  }
  function paint() {
    const results = q("#cd-results");
    results.replaceChildren();
    matches.forEach((i, n) => {
      const b = button(i.name, () => select(i));
      decorate(b, i);
      b.id = "cd-option-" + n;
      b.setAttribute("role", "option");
      b.setAttribute("aria-selected", String(n === active));
      b.style.background = n === active ? "#edf4ff" : "white";
      b.onmousedown = (e) => e.preventDefault();
      results.append(b);
    });
    if (!matches.length)
      results.append(node("span", "일치하는 아이템이 없습니다.", "cd-small"));
    q("#cd-text").setAttribute("aria-expanded", "true");
    if (matches.length)
      q("#cd-text").setAttribute(
        "aria-activedescendant",
        "cd-option-" + active,
      );
    else q("#cd-text").removeAttribute("aria-activedescendant");
    q("#cd-picker").hidden = false;
  }
  function search() {
    sync();
    const box = q("#cd-text"),
      end = box.selectionStart,
      before = box.value.slice(0, end),
      start = before.lastIndexOf("@");
    if (start < 0 || box.selectionStart !== box.selectionEnd) {
      hide();
      return;
    }
    const term = before.slice(start + 1);
    if (
      /[\n@]/.test(term) ||
      mentions.some((i) => before.slice(start).startsWith("@" + i.name))
    ) {
      hide();
      return;
    }
    query = { start, end };
    matches = items.filter((i) => normalize(i.name).includes(normalize(term)));
    active = 0;
    paint();
  }
  q("#cd-text").addEventListener("input", () => {
    if (!composing) search();
  });
  q("#cd-text").addEventListener("compositionstart", () => (composing = true));
  q("#cd-text").addEventListener("compositionend", () => {
    composing = false;
    search();
  });
  q("#cd-text").addEventListener("click", search);
  q("#cd-text").addEventListener("keydown", (e) => {
    if (e.isComposing || composing) return;
    if (e.key === "Escape") {
      hide();
      return;
    }
    if (!query || !matches.length) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      active =
        (active + (e.key === "ArrowDown" ? 1 : -1) + matches.length) %
        matches.length;
      paint();
      q("#cd-option-" + active).scrollIntoView({ block: "nearest" });
    }
    if (e.key === "Enter") {
      e.preventDefault();
      select(matches[active]);
    }
  });
  q("#cd-all").onclick = () => {
    scope = null;
    load(true);
  };
  q("#cd-current").onclick = () => {
    if (!current()) {
      q("#cd-notice").textContent = "목록에서 아이템을 먼저 선택해 주세요.";
      return;
    }
    scope = current();
    load(true);
  };
  function opened(value, focus = true) {
    panel.classList.toggle("cd-closed", !value);
    panel.inert = !value;
    panel.setAttribute("aria-hidden", String(!value));
    launch.textContent = value ? "≫" : "≪";
    launch.setAttribute("aria-label", value ? "시세 이야기 접기" : "시세 이야기 열기");
    launch.setAttribute("aria-expanded", String(value));
    railChat.setAttribute("aria-pressed", String(value));
    railChat.setAttribute("aria-label", value ? "시세 이야기 접기" : "시세 이야기 열기");
    document.body.classList.toggle("market-chat-open", value);
    if (focus) (value ? q("#cd-close") : launch).focus();
    window.dispatchEvent(new Event("resize"));
  }
  panel.addEventListener("transitionend", (e) => {
    if (e.target === panel && e.propertyName === "transform")
      window.dispatchEvent(new Event("resize"));
  });
  q("#cd-close").onclick = () => opened(false);
  launch.onclick = () => opened(panel.classList.contains("cd-closed"));
  railChat.onclick = launch.onclick;
  panel.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !query) opened(false);
  });

  const extras = document.createElement("style");
  extras.textContent =
    "#cd-panel .cd-link.cd-item{display:inline-flex;align-items:center;gap:6px;padding:4px 7px;background:#edf4ff;border-radius:7px;vertical-align:middle}#cd-panel .cd-icon{width:24px;height:24px;object-fit:contain;border-radius:4px;vertical-align:middle;margin-right:6px}#cd-unread{margin:8px 16px;background:#edf4ff!important;color:#1765cc!important}#cd-draft{font-size:11px;color:#65788d;margin:0 0 6px}";
  document.head.append(extras);
  function decorate(b, i) {
    if (b.querySelector(".cd-icon")) return;
    b.classList.add("cd-item");
    if (i.hash === "legendary-card") {
      const icon = node("span", "▦", "cd-icon");
      b.prepend(icon);
      return;
    }
    const img = document.createElement("img");
    img.className = "cd-icon";
    img.alt = "";
    img.src = "https://img-api.neople.co.kr/df/items/" + i.hash;
    img.onerror = () => img.remove();
    b.prepend(img);
  }
  const draftStatus = node("div", "", "cd-small");
  draftStatus.id = "cd-draft";
  q("#cd-text").after(draftStatus);
  function saveDraft() {
    try {
      localStorage.setItem(
        "market-chat-draft-v1",
        JSON.stringify({
          text: q("#cd-text").value,
          nick: q("#cd-nick").value,
          ids: mentions.map((i) => i.id),
        }),
      );
      draftStatus.textContent = q("#cd-text").value
        ? "초안 저장됨 · 이 브라우저에만 보관"
        : "";
    } catch {
      draftStatus.textContent = "초안을 저장할 수 없어요";
    }
  }
  try {
    const d = JSON.parse(localStorage.getItem("market-chat-draft-v1") || "null");
    if (d) {
      q("#cd-text").value = String(d.text || "").slice(0, 200);
      q("#cd-nick").value = String(d.nick || "").slice(0, 12);
      mentions = items.filter((i) => (d.ids || []).includes(i.id));
      sync();
      draftStatus.textContent = d.text ? "작성하던 초안을 복원했어요" : "";
    }
  } catch {}
  q("#cd-text").addEventListener("input", saveDraft);
  q("#cd-nick").addEventListener("input", saveDraft);
  let unread = 0;
  const news = node("button", "", "");
  news.id = "cd-unread";
  news.hidden = true;
  news.type = "button";
  q("#cd-list").after(news);
  function updateUnread() {
    news.hidden = !unread;
    news.textContent = "새 이야기 " + unread + "개 ↑";
    railBadge.hidden = !unread;
    railBadge.textContent = unread > 99 ? "99+" : String(unread);
    railChat.title = unread ? "새 이야기 " + unread + "개" : "시세 이야기";
  }
  news.onclick = () => {
    q("#cd-list").scrollTop = 0;
    unread = 0;
    updateUnread();
  };

  const more = button("이전 이야기 더 보기", () => load(false, true));
  more.hidden = true;
  q("#cd-list").after(more);
  const retry = button("새로고침", () => load(true));
  q("header").append(retry);
  const adminButton = button("관리", () => {
    if (adminPassword) {
      adminPassword = "";
      adminButton.textContent = "관리";
      load(true);
      return;
    }
    showDialog("게시판 관리자 비밀번호", true, async (value) => {
      await api("admin-login", { adminPassword: value });
      adminPassword = value;
      adminButton.textContent = "관리 종료";
      adminUntil = Date.now() + 15 * 60000;
      await load(true);
    });
  });
  q("header").append(adminButton);
  setInterval(() => {
    if (adminPassword && Date.now() > adminUntil) {
      adminPassword = "";
      load(true);
    }
  }, 30000);
  q("#cd-form").append(
    node(
      "p",
      "삭제 권한은 이 브라우저에 저장됩니다. 브라우저 데이터를 지우면 관리자에게 삭제를 요청해 주세요.",
      "cd-small",
    ),
  );
  const dialog = document.createElement("dialog");
  dialog.style.cssText =
    "border:1px solid #d8e2ee;border-radius:12px;padding:20px;max-width:90vw";
  const title = node("p", ""),
    secret = document.createElement("input"),
    err = node("p", ""),
    ok = node("button", "확인"),
    no = node("button", "취소");
  secret.type = "password";
  secret.autocomplete = "current-password";
  secret.setAttribute("aria-label", "관리자 비밀번호");
  dialog.append(title, secret, err, no, ok);
  document.body.append(dialog);
  no.onclick = () => dialog.close();
  dialog.addEventListener("close", () => (secret.value = ""));
  function showDialog(text, password, task) {
    title.textContent = text;
    secret.hidden = !password;
    secret.value = "";
    err.textContent = "";
    ok.onclick = async () => {
      ok.disabled = true;
      try {
        await task(secret.value);
        dialog.close();
      } catch (e) {
        err.textContent = e.message;
      } finally {
        ok.disabled = false;
      }
    };
    dialog.showModal();
  }
  q("#cd-form").onsubmit = async (e) => {
    e.preventDefault();
    if (busy) return;
    const text = q("#cd-text").value.trim();
    if (!text) return;
    sync();
    const payload = {
      nickname: q("#cd-nick").value.trim() || "모험가",
      body: text,
      tags: mentions.map((i) => i.id),
      ...(reply ? { parent: reply } : {}),
    };
    const signature = JSON.stringify(payload);
    try {
      if (!pending || pending.signature !== signature)
        pending = {
          signature,
          requestId: crypto.randomUUID(),
          password: crypto.randomUUID() + crypto.randomUUID().slice(0, 20),
        };
      localStorage.setItem("market-chat-pending", JSON.stringify(pending));
    } catch {
      q("#cd-notice").textContent =
        "브라우저 저장소를 허용해야 본인 글 삭제키를 보관할 수 있어요.";
      return;
    }
    busy = true;
    const submit = q("button[type=submit]");
    submit.disabled = true;
    q("#cd-notice").textContent = "등록 중…";
    try {
      const result = await api("chat-create", {
        ...payload,
        requestId: pending.requestId,
        password: pending.password,
      });
      owners[result.id] = pending.password;
      localStorage.setItem("market-chat-owners", JSON.stringify(owners));
      localStorage.removeItem("market-chat-pending");
      pending = null;
      q("#cd-text").value = "";
      mentions = [];
      hide();
      cancel();
      saveDraft();
      await load(true);
      q("#cd-notice").textContent = "등록했습니다.";
    } catch (e) {
      q("#cd-notice").textContent =
        "등록 결과를 확인하지 못했어요. 같은 내용으로 다시 누르면 중복 등록을 방지합니다. " +
        e.message;
    } finally {
      busy = false;
      submit.disabled = false;
    }
  };
  try {
    pending = JSON.parse(localStorage.getItem("market-chat-pending") || "null");
  } catch {}
  window.addEventListener("hashchange", () => {
    if (!q("#cd-text").value.trim()) {
      cancel();
    }
    if (scope !== null) {
      scope = current();
      load(true);
    }
  });
  render();
  opened(false, false);
  load(true);
  setTimeout(tick, 30000);
})().catch(() => {
  const retry = document.createElement("button");
  retry.textContent = "시세 이야기 연결 실패 · 새로고침";
  retry.style.cssText = "position:fixed;right:16px;bottom:16px;z-index:40;padding:12px";
  retry.onclick = () => location.reload();
  document.body.append(retry);
});
