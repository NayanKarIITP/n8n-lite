-- seed_demo_orgs.sql
--
-- Run this AFTER signing up the six demo users through the app's
-- /auth/sign-up page (Nhost auth owns the users table — we don't insert
-- into auth.users directly). Replace the six placeholder UUIDs with the
-- real auth.users.id values, findable via:
--   select id, email from auth.users order by created_at desc;
--
-- See README "Demo users/organizations" for the full walkthrough.

insert into public.organizations (name, usage_limit) values
  ('Org A', 100),
  ('Org B', 100);

-- Grab the two org ids you just created:
--   select id, name from public.organizations where name in ('Org A','Org B');

-- Replace :org_a_id / :org_b_id and the six :*_user_id placeholders, then run:

-- insert into public.org_members (org_id, user_id, role) values
--   (:org_a_id, :owner_a_user_id,  'owner'),
--   (:org_a_id, :editor_a_user_id, 'editor'),
--   (:org_a_id, :viewer_a_user_id, 'viewer'),
--   (:org_b_id, :owner_b_user_id,  'owner'),
--   (:org_b_id, :editor_b_user_id, 'editor'),
--   (:org_b_id, :viewer_b_user_id, 'viewer');
