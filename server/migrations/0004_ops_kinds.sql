alter table ops drop constraint ops_kind_valid;
alter table ops add constraint ops_kind_valid check (kind in ('task', 'suggestion', 'event', 'ai'));
