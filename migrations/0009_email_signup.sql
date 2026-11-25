-- WTP Question Rank: sign-up by email with a self-chosen role (owner decision, 25 Nov 2026; see DEVIATIONS.md).
-- Until now the site stored no names or email addresses: a voter was a hashed code, a role the owner assigned and a
-- neutral label (the comment at the top of 0001_init.sql still says so; that file is frozen). The owner changed that
-- rule for adults who sign up through a sign-up link:
--   * voters.email is the address typed at sign-up, lower-cased. It is NOT verified: it works as a username.
--     NULL for a voter who was given a code. One voter per address.
--   * voters.name is optional, as typed.
--   * voters.join_link_id says which sign-up link the voter came through.
--   * join_links are the sign-up links. Like an invite code, a link's word is derived from CODE_PEPPER and the link's
--     id; only its keyed hash is stored. A link with closed_at set takes no new sign-ups; addresses already signed up
--     keep working.
-- Students do not sign up by email (the sign-up form offers the adult roles only), so no student address is stored.
-- An address or name never goes to a voter page or into the round export; it is in /admin, the voters CSV and the
-- full backup.

ALTER TABLE voters ADD COLUMN email TEXT;
ALTER TABLE voters ADD COLUMN name TEXT;
ALTER TABLE voters ADD COLUMN join_link_id TEXT;
CREATE UNIQUE INDEX voters_email ON voters(email) WHERE email IS NOT NULL;

CREATE TABLE join_links (
  id          TEXT PRIMARY KEY,
  word_hash   TEXT NOT NULL UNIQUE,
  created_at  TEXT NOT NULL,
  closed_at   TEXT
);
