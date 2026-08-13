-- User provisioning.
--
-- Creating a user is a chicken-and-egg problem for RLS: the policy on `users`
-- requires `id = app_current_user_id()`, but at signup there is no id yet.
--
-- Rather than loosening the policy (which would let any session read or write
-- any user row), provisioning goes through a SECURITY DEFINER function. It
-- runs as the owner, so it bypasses RLS — but it is the ONLY such path, it
-- takes exactly the fields needed, and it can only ever touch the single row
-- matching the IdP subject the caller presents.
--
-- The subject itself is not attacker-controlled: it comes from an ID token
-- whose signature, issuer, audience and nonce the app has already verified.

CREATE OR REPLACE FUNCTION provision_user(
  p_subject TEXT,
  p_issuer  TEXT,
  p_email   TEXT,
  p_name    TEXT
) RETURNS TABLE (id BIGINT, email TEXT, display_name TEXT, blocked BOOLEAN)
LANGUAGE plpgsql
SECURITY DEFINER
-- Pin the search path so a caller cannot shadow `users` with their own table.
SET search_path = public, pg_temp
AS $$
BEGIN
  IF p_subject IS NULL OR length(trim(p_subject)) = 0 THEN
    RAISE EXCEPTION 'provision_user requires a subject';
  END IF;

  RETURN QUERY
  INSERT INTO users (idp_subject, idp_issuer, email, display_name)
  VALUES (p_subject, COALESCE(p_issuer, ''), p_email, COALESCE(p_name, ''))
  ON CONFLICT (idp_subject) DO UPDATE
    SET email        = EXCLUDED.email,
        display_name = EXCLUDED.display_name,
        last_seen_at = now()
  RETURNING users.id, users.email, users.display_name, users.blocked;
END
$$;

-- Only the application role may call it; PUBLIC must not.
REVOKE ALL ON FUNCTION provision_user(TEXT, TEXT, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION provision_user(TEXT, TEXT, TEXT, TEXT) TO habiterall_app;

-- Let a signed-in user read and update their own row through normal RLS,
-- but never INSERT one directly: that is what provision_user is for.
DROP POLICY IF EXISTS users_self ON users;

CREATE POLICY users_select_self ON users
  FOR SELECT USING (id = app_current_user_id());

CREATE POLICY users_update_self ON users
  FOR UPDATE USING (id = app_current_user_id())
             WITH CHECK (id = app_current_user_id());

REVOKE INSERT, DELETE ON users FROM habiterall_app;
