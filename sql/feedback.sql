-- 게시판 전용 권한만 설정한다. 시세 수집 테이블과 기존 권한은 변경하지 않는다.
BEGIN;
CREATE SCHEMA IF NOT EXISTS feedback_private;
REVOKE ALL ON SCHEMA feedback_private FROM PUBLIC, anon, authenticated, service_role;

CREATE TABLE IF NOT EXISTS public.feedback_posts (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  nickname text NOT NULL CHECK (char_length(nickname) BETWEEN 1 AND 20),
  category text NOT NULL CHECK (category IN ('bug', 'idea', 'general')),
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 100),
  body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 5000),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'reviewing', 'done', 'closed')),
  reply text NOT NULL DEFAULT '' CHECK (char_length(reply) <= 5000),
  replied_at timestamptz,
  hidden boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS feedback_private.post_passwords (
  post_id bigint PRIMARY KEY REFERENCES public.feedback_posts(id) ON DELETE CASCADE,
  password_hash text NOT NULL
);
CREATE TABLE IF NOT EXISTS feedback_private.admin (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  password_hash text NOT NULL
);
CREATE TABLE IF NOT EXISTS feedback_private.rate_limits (
  key text PRIMARY KEY,
  hits integer NOT NULL,
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS feedback_rate_expiry ON feedback_private.rate_limits(expires_at);
ALTER TABLE public.feedback_posts ENABLE ROW LEVEL SECURITY;
ALTER TABLE feedback_private.post_passwords ENABLE ROW LEVEL SECURITY;
ALTER TABLE feedback_private.admin ENABLE ROW LEVEL SECURITY;
ALTER TABLE feedback_private.rate_limits ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.feedback_posts FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON SEQUENCE public.feedback_posts_id_seq FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON ALL TABLES IN SCHEMA feedback_private FROM PUBLIC, anon, authenticated, service_role;

-- 검증 실패도 횟수에 포함되도록 본문 처리와 별도 RPC 트랜잭션에서 실행한다.
CREATE OR REPLACE FUNCTION public.feedback_rate_limit(p_rules jsonb) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE r jsonb; n integer; seconds integer; cap integer;
BEGIN
  DELETE FROM feedback_private.rate_limits WHERE expires_at < now();
  FOR r IN SELECT value FROM jsonb_array_elements(p_rules) LOOP
    seconds := (r->>'seconds')::integer;
    cap := (r->>'limit')::integer;
    INSERT INTO feedback_private.rate_limits AS target(key,hits,expires_at)
      VALUES (r->>'key',1,now()+make_interval(secs=>seconds))
      ON CONFLICT(key) DO UPDATE SET
        hits=CASE WHEN target.expires_at<=now() THEN 1 ELSE least(target.hits+1,cap+1) END,
        expires_at=CASE WHEN target.expires_at<=now() THEN now()+make_interval(secs=>seconds) ELSE target.expires_at END
      RETURNING hits INTO n;
    IF n>cap THEN RETURN false; END IF;
  END LOOP;
  RETURN true;
END $$;

CREATE OR REPLACE FUNCTION public.feedback_request(p_action text,p_data jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  post public.feedback_posts;
  hash text;
  admin_mode boolean := coalesce((p_data->>'admin')::boolean,false);
  password text := coalesce(p_data->>'password','');
  admin_password text := coalesce(p_data->>'adminPassword','');
  results jsonb;
BEGIN
  IF admin_mode OR p_action IN ('admin-login','moderate') THEN
    SELECT password_hash INTO hash FROM feedback_private.admin WHERE singleton;
    IF hash IS NULL OR octet_length(admin_password) NOT BETWEEN 12 AND 72
      OR extensions.crypt(admin_password,hash) IS DISTINCT FROM hash THEN
      RETURN jsonb_build_object('error','관리자 비밀번호를 확인해 주세요.','status',401);
    END IF;
    admin_mode := true;
  END IF;
  IF p_action='admin-login' THEN RETURN jsonb_build_object('ok',true); END IF;
  IF p_action='list' THEN
    SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY t.id DESC),'[]'::jsonb) INTO results FROM (
      SELECT id,nickname,category,title,status,reply<>'' AS answered,hidden,created_at,updated_at
      FROM public.feedback_posts WHERE (admin_mode OR NOT hidden)
        AND (p_data->>'before' IS NULL OR id<(p_data->>'before')::bigint)
      ORDER BY id DESC LIMIT 21
    ) t;
    RETURN jsonb_build_object('posts',results);
  END IF;
  IF p_action IN ('create','edit') THEN
    IF char_length(btrim(coalesce(p_data->>'nickname',''))) NOT BETWEEN 1 AND 20
      OR lower(regexp_replace(p_data->>'nickname','\s','','g')) IN ('관리자','운영자','admin')
      OR char_length(btrim(coalesce(p_data->>'title',''))) NOT BETWEEN 1 AND 100
      OR char_length(btrim(coalesce(p_data->>'body',''))) NOT BETWEEN 1 AND 5000
      OR coalesce(p_data->>'category','') NOT IN ('bug','idea','general')
      OR char_length(password)<8 OR octet_length(password)>72 THEN
      RETURN jsonb_build_object('error','입력 항목과 글 비밀번호(8자 이상)를 확인해 주세요.','status',422);
    END IF;
  END IF;
  IF p_action='create' THEN
    INSERT INTO public.feedback_posts(nickname,category,title,body)
      VALUES(btrim(p_data->>'nickname'),p_data->>'category',btrim(p_data->>'title'),btrim(p_data->>'body')) RETURNING * INTO post;
    INSERT INTO feedback_private.post_passwords VALUES(post.id,extensions.crypt(password,extensions.gen_salt('bf',10)));
    RETURN jsonb_build_object('post',to_jsonb(post));
  END IF;
  SELECT * INTO post FROM public.feedback_posts WHERE id=(p_data->>'id')::bigint
    AND (admin_mode OR NOT hidden) FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('error','글을 찾을 수 없습니다. 삭제되었거나 숨겨진 글일 수 있습니다.','status',404); END IF;
  IF p_action='detail' THEN RETURN jsonb_build_object('post',to_jsonb(post)); END IF;
  IF p_action IN ('edit','delete') THEN
    SELECT password_hash INTO hash FROM feedback_private.post_passwords WHERE post_id=post.id;
    IF char_length(password)<8 OR octet_length(password)>72 OR extensions.crypt(password,hash) IS DISTINCT FROM hash THEN
      RETURN jsonb_build_object('error','글 비밀번호가 일치하지 않습니다.','status',401);
    END IF;
  ELSIF p_action<>'moderate' THEN
    RETURN jsonb_build_object('error','지원하지 않는 요청입니다.','status',400);
  END IF;
  IF post.updated_at IS DISTINCT FROM (p_data->>'version')::timestamptz THEN
    RETURN jsonb_build_object('error','다른 변경이 반영됐습니다. 글을 다시 열고 시도해 주세요.','status',409);
  END IF;
  IF p_action='delete' THEN
    DELETE FROM public.feedback_posts WHERE id=post.id;
    RETURN jsonb_build_object('ok',true);
  ELSIF p_action='edit' THEN
    UPDATE public.feedback_posts SET nickname=btrim(p_data->>'nickname'),category=p_data->>'category',
      title=btrim(p_data->>'title'),body=btrim(p_data->>'body'),updated_at=clock_timestamp() WHERE id=post.id RETURNING * INTO post;
  ELSE
    IF coalesce(p_data->>'status','') NOT IN ('open','reviewing','done','closed') OR char_length(coalesce(p_data->>'reply',''))>5000 THEN
      RETURN jsonb_build_object('error','답변과 처리 상태를 확인해 주세요.','status',422);
    END IF;
    UPDATE public.feedback_posts SET status=p_data->>'status',reply=btrim(coalesce(p_data->>'reply','')),
      replied_at=CASE WHEN reply IS DISTINCT FROM btrim(coalesce(p_data->>'reply','')) THEN clock_timestamp() ELSE replied_at END,
      hidden=coalesce((p_data->>'hidden')::boolean,false),updated_at=clock_timestamp() WHERE id=post.id RETURNING * INTO post;
  END IF;
  RETURN jsonb_build_object('post',to_jsonb(post));
END $$;
REVOKE ALL ON FUNCTION public.feedback_rate_limit(jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.feedback_request(text,jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.feedback_rate_limit(jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.feedback_request(text,jsonb) TO service_role;
NOTIFY pgrst, 'reload schema';
COMMIT;
