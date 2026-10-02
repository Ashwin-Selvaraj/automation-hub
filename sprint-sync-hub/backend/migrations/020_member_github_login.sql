-- 020_member_github_login.sql
--
-- Maps a team member to their GitHub username, so a pull request waiting on
-- "bob-dev" can be shown as Bob and, if the review nudge is switched on,
-- reach him in Slack.
--
-- GitHub does not reliably expose an account's email address, so unlike Jira
-- (matched by email) this link has to be entered by a person. Additive only:
-- one nullable column and one index, nothing existing is altered.

ALTER TABLE members
  ADD COLUMN IF NOT EXISTS github_login VARCHAR(100);

-- GitHub logins are case-insensitive, so uniqueness is too. Partial, so any
-- number of members can be unmapped.
CREATE UNIQUE INDEX IF NOT EXISTS idx_members_github_login
  ON members (organisation_id, LOWER(github_login))
  WHERE github_login IS NOT NULL;
