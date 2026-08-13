-- Key users on (issuer, subject), not subject alone.
--
-- SECURITY FIX. `users.idp_subject` was UNIQUE on its own and provision_user
-- did ON CONFLICT (idp_subject), so a token from a DIFFERENT issuer carrying
-- the same `sub` resolved to the EXISTING user's row — returning their id and
-- handing the caller their account.
--
-- Not reachable with a single configured IdP, because openid-client validates
-- `iss` against the one discovered issuer. It becomes live the moment a second
-- IdP is added, an issuer URL changes, or a multi-tenant IdP reuses subject
-- values across realms. OIDC only guarantees `sub` is unique WITHIN an issuer,
-- so (iss, sub) is the correct identity — which the code comments already
-- claimed.

-- Existing rows all came from one issuer, so this cannot collide today.
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_idp_subject_key;

CREATE UNIQUE INDEX IF NOT EXISTS users_idp_identity_key
  ON users (idp_issuer, idp_subject);

CREATE OR REPLACE FUNCTION provision_user(
  p_subject TEXT,
  p_issuer  TEXT,
  p_email   TEXT,
  p_name    TEXT
) RETURNS TABLE (id BIGINT, email TEXT, display_name TEXT, blocked BOOLEAN)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF p_subject IS NULL OR length(trim(p_subject)) = 0 THEN
    RAISE EXCEPTION 'provision_user requires a subject';
  END IF;

  -- The issuer is half the identity, so it must be present and is no longer
  -- allowed to default to the empty string.
  IF p_issuer IS NULL OR length(trim(p_issuer)) = 0 THEN
    RAISE EXCEPTION 'provision_user requires an issuer';
  END IF;

  RETURN QUERY
  INSERT INTO users (idp_subject, idp_issuer, email, display_name)
  VALUES (p_subject, p_issuer, p_email, COALESCE(p_name, ''))
  ON CONFLICT (idp_issuer, idp_subject) DO UPDATE
    SET email        = EXCLUDED.email,
        display_name = EXCLUDED.display_name,
        last_seen_at = now()
  RETURNING users.id, users.email, users.display_name, users.blocked;
END
$$;

REVOKE ALL ON FUNCTION provision_user(TEXT, TEXT, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION provision_user(TEXT, TEXT, TEXT, TEXT) TO habiterall_app;

-- ---------------------------------------------------------------------------
-- I2: narrow the app role's UPDATE on `users` to the columns that legitimately
-- change. It previously held table-wide UPDATE, so a future profile-edit
-- endpoint (or an injection into one) could clear `blocked` to unsuspend an
-- account, or repoint `idp_subject` to hijack another identity.
-- ---------------------------------------------------------------------------

REVOKE UPDATE ON users FROM habiterall_app;
GRANT UPDATE (email, display_name, last_seen_at) ON users TO habiterall_app;
