-- Attempts are recorded before the password is checked (so parallel requests can't slip past the limit);
-- a successful attempt's row is removed again by id.
alter table unlock_attempts add column id bigserial primary key;
