-- 기존 게시판과 별도 저장. feedback.sql 이후 적용한다.
BEGIN;
CREATE SCHEMA IF NOT EXISTS chat_private;
REVOKE ALL ON SCHEMA chat_private FROM PUBLIC, anon, authenticated, service_role;
CREATE TABLE IF NOT EXISTS public.chat_posts (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  parent_id bigint REFERENCES public.chat_posts(id),
  nickname text NOT NULL CHECK (char_length(nickname) BETWEEN 1 AND 20),
  body text NOT NULL CHECK (char_length(body) <= 200),
  tags jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(tags)='array' AND jsonb_array_length(tags)<=5),
  hidden boolean NOT NULL DEFAULT false,
  deleted boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS chat_parent_idx ON public.chat_posts(parent_id,id);
CREATE TABLE IF NOT EXISTS chat_private.owners (
  post_id bigint PRIMARY KEY REFERENCES public.chat_posts(id),
  request_id uuid UNIQUE NOT NULL,
  password_hash text NOT NULL
);
ALTER TABLE public.chat_posts ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_private.owners ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.chat_posts, chat_private.owners FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON SEQUENCE public.chat_posts_id_seq FROM PUBLIC,anon,authenticated,service_role;
CREATE OR REPLACE FUNCTION public.chat_request(p_action text,p_data jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE
  post public.chat_posts;
  parent public.chat_posts;
  admin_mode boolean := coalesce((p_data->>'admin')::boolean,false);
  hash text;
  pw text := coalesce(p_data->>'password','');
  results jsonb;
BEGIN
  IF admin_mode OR p_action='chat-moderate' THEN
    SELECT password_hash INTO hash FROM feedback_private.admin WHERE singleton;
    IF hash IS NULL OR octet_length(coalesce(p_data->>'adminPassword','')) NOT BETWEEN 12 AND 72
      OR extensions.crypt(p_data->>'adminPassword',hash) IS DISTINCT FROM hash THEN
      RETURN jsonb_build_object('error','관리자 비밀번호를 확인해 주세요.','status',401);
    END IF;
    admin_mode := true;
  END IF;
  IF p_action='chat-list' THEN
    SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY t.id DESC),'[]'::jsonb) INTO results FROM (
      SELECT p.*, coalesce((SELECT jsonb_agg(to_jsonb(r) ORDER BY r.id) FROM public.chat_posts r
        WHERE r.parent_id=p.id AND (admin_mode OR NOT r.hidden)),'[]'::jsonb) AS replies
      FROM public.chat_posts p WHERE p.parent_id IS NULL AND (admin_mode OR NOT p.hidden)
        AND (p_data->>'before' IS NULL OR p.id<(p_data->>'before')::bigint)
        AND (p_data->>'tag' IS NULL OR p.tags ? (p_data->>'tag') OR EXISTS(
          SELECT 1 FROM public.chat_posts r WHERE r.parent_id=p.id AND NOT r.deleted
            AND (admin_mode OR NOT r.hidden) AND r.tags ? (p_data->>'tag')))
      ORDER BY p.id DESC LIMIT 21
    ) t;
    RETURN jsonb_build_object('posts',results);
  END IF;
  IF p_action='chat-create' THEN
    IF char_length(btrim(coalesce(p_data->>'nickname',''))) NOT BETWEEN 1 AND 20
      OR lower(regexp_replace(p_data->>'nickname','\s','','g')) IN ('관리자','운영자','admin')
      OR char_length(btrim(coalesce(p_data->>'body',''))) NOT BETWEEN 1 AND 200
      OR char_length(pw)<8 OR octet_length(pw)>72
      OR jsonb_typeof(p_data->'tags') IS DISTINCT FROM 'array' THEN
      RETURN jsonb_build_object('error','입력 항목을 확인해 주세요.','status',422);
    END IF;
    IF jsonb_array_length(p_data->'tags')>5 OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(p_data->'tags') x
      WHERE x !~ '^(?:[a-f0-9]{32}(?::max)?|legendary-card)$') THEN
      RETURN jsonb_build_object('error','아이템 태그를 확인해 주세요.','status',422);
    END IF;
    -- 응답 유실 후 재시도해도 같은 글을 두 번 만들지 않는다.
    PERFORM pg_advisory_xact_lock(hashtextextended(p_data->>'requestId',0));
    SELECT p.* INTO post FROM public.chat_posts p JOIN chat_private.owners o ON o.post_id=p.id
      WHERE o.request_id=(p_data->>'requestId')::uuid;
    IF FOUND THEN
      SELECT password_hash INTO hash FROM chat_private.owners WHERE post_id=post.id;
      IF extensions.crypt(pw,hash) IS DISTINCT FROM hash THEN
        RETURN jsonb_build_object('error','등록 정보가 일치하지 않습니다.','status',409);
      END IF;
      RETURN jsonb_build_object('id',post.id);
    END IF;
    IF p_data->>'parent' IS NOT NULL THEN
      SELECT * INTO parent FROM public.chat_posts WHERE id=(p_data->>'parent')::bigint FOR UPDATE;
      IF NOT FOUND OR parent.hidden OR parent.deleted OR parent.parent_id IS NOT NULL THEN
        RETURN jsonb_build_object('error','답글을 달 수 없는 글입니다.','status',404);
      END IF;
      IF (SELECT count(*) FROM public.chat_posts WHERE parent_id=parent.id)>=50 THEN
        RETURN jsonb_build_object('error','답글이 50개입니다. 새 이야기로 이어 주세요.','status',422);
      END IF;
    END IF;
    INSERT INTO public.chat_posts(parent_id,nickname,body,tags)
      VALUES ((p_data->>'parent')::bigint,btrim(p_data->>'nickname'),btrim(p_data->>'body'),p_data->'tags') RETURNING * INTO post;
    INSERT INTO chat_private.owners VALUES(post.id,(p_data->>'requestId')::uuid,extensions.crypt(pw,extensions.gen_salt('bf',10)));
    RETURN jsonb_build_object('id',post.id);
  END IF;
  SELECT * INTO post FROM public.chat_posts WHERE id=(p_data->>'id')::bigint FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('error','글을 찾을 수 없습니다.','status',404); END IF;
  IF p_action='chat-delete' THEN
    SELECT password_hash INTO hash FROM chat_private.owners WHERE post_id=post.id;
    IF char_length(pw)<8 OR octet_length(pw)>72 OR extensions.crypt(pw,hash) IS DISTINCT FROM hash THEN
      RETURN jsonb_build_object('error','글 관리키가 일치하지 않습니다.','status',401);
    END IF;
    UPDATE public.chat_posts SET body='',nickname='삭제됨',tags='[]',deleted=true WHERE id=post.id;
  ELSIF p_action='chat-moderate' AND admin_mode THEN
    UPDATE public.chat_posts SET hidden=(p_data->>'hidden')::boolean WHERE id=post.id;
  ELSE RETURN jsonb_build_object('error','지원하지 않는 요청입니다.','status',400);
  END IF;
  RETURN jsonb_build_object('ok',true);
END $$;
REVOKE ALL ON FUNCTION public.chat_request(text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.chat_request(text,jsonb) TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
