-- Schema and trusted RPC boundary. Run once in a new Supabase project.
create sequence public.attendance_employee_number;
create table public.attendance_employees (
 id uuid primary key default gen_random_uuid(), code text not null unique default ('E'||lpad(nextval('public.attendance_employee_number')::text,3,'0')),
 line_sub text not null unique check(line_sub ~ '^U[0-9a-fA-F]{32}$'), name text not null check(length(name) between 1 and 80),
 role text not null default 'employee' check(role in ('employee','admin')), enabled boolean not null default true, created_at timestamptz not null default now()
);
create table public.attendance_sessions (hash text primary key check(hash ~ '^[0-9a-f]{64}$'), employee_id uuid not null references public.attendance_employees, expires_at timestamptz not null default (now()+interval '30 minutes'));
create index on public.attendance_sessions(employee_id);
create table public.attendance_locations (id uuid primary key default gen_random_uuid(), name text not null check(length(name) between 1 and 60), lat double precision not null check(lat between -90 and 90), lng double precision not null check(lng between -180 and 180), radius_meters integer not null default 2000 check(radius_meters between 100 and 100000), enabled boolean not null default true, version integer not null default 1);
create table public.attendance_punches (
 id uuid primary key default gen_random_uuid(), ordinal bigint generated always as identity unique, employee_id uuid not null references public.attendance_employees,
 type text not null check(type in ('in','out')), occurred_at timestamptz not null, source text not null check(source in ('device','correction')),
 location_snapshot jsonb, distance_meters double precision, position jsonb, request_id uuid,
 idempotency_key text, fingerprint text, unique(employee_id,idempotency_key)
);
create index on public.attendance_punches(employee_id,occurred_at desc,ordinal desc);
create table public.attendance_corrections (
 id uuid primary key default gen_random_uuid(), employee_id uuid not null references public.attendance_employees, type text not null check(type in ('in','out')),
 occurred_at timestamptz not null, reason text not null check(length(reason) between 3 and 500), status text not null default 'pending' check(status in ('pending','approved','rejected')),
 created_at timestamptz not null default now(), reviewer_id uuid references public.attendance_employees, reviewed_at timestamptz, review_note text,
 check(reviewer_id is null or reviewer_id<>employee_id)
);
create unique index on public.attendance_corrections(employee_id,type,occurred_at) where status='pending';
alter table public.attendance_punches add foreign key(request_id) references public.attendance_corrections;
create table public.attendance_audit (id bigint generated always as identity primary key, actor_id uuid references public.attendance_employees, action text not null, detail jsonb not null, occurred_at timestamptz not null default clock_timestamp());
alter table public.attendance_employees enable row level security;
alter table public.attendance_sessions enable row level security;
alter table public.attendance_locations enable row level security;
alter table public.attendance_punches enable row level security;
alter table public.attendance_corrections enable row level security;
alter table public.attendance_audit enable row level security;
revoke all on public.attendance_employees, public.attendance_sessions, public.attendance_locations, public.attendance_punches, public.attendance_corrections, public.attendance_audit from public,anon,authenticated;

create function public.attendance_person(e public.attendance_employees) returns jsonb language sql immutable set search_path='' as $$
 select jsonb_build_object('id',e.id,'code',e.code,'name',e.name,'role',e.role,'enabled',e.enabled,'lineHint',right(e.line_sub,6));
$$;
create function public.attendance_record(r public.attendance_punches) returns jsonb language sql immutable set search_path='' as $$
 select jsonb_build_object('id',r.id,'employeeId',r.employee_id,'type',r.type,'timestamp',r.occurred_at,'source',r.source,'locationName',coalesce(r.location_snapshot->>'name','核准補打卡'),'distanceMeters',r.distance_meters,'requestId',r.request_id);
$$;
create function public.attendance_distance(a double precision,b double precision,c double precision,d double precision) returns double precision language sql immutable set search_path='' as $$
 select 6371008.8*2*asin(sqrt(least(1.0,greatest(0.0,power(sin(radians(c-a)/2),2)+cos(radians(a))*cos(radians(c))*power(sin(radians(d-b)/2),2)))));
$$;
create function public.attendance_rpc(p_op text,p_session_hash text default null,p_payload jsonb default '{}') returns jsonb
language plpgsql security definer set search_path='' as $$
declare
 a public.attendance_employees%rowtype; target public.attendance_employees%rowtype;
 r public.attendance_punches%rowtype; last_p public.attendance_punches%rowtype; req public.attendance_corrections%rowtype; loc public.attendance_locations%rowtype;
 profile jsonb; result jsonb; v_id uuid; v_type text; v_time timestamptz; v_distance double precision; v_accuracy double precision; v_bad boolean; v_from date; v_to date;
begin
 -- Serialize this small team's operations, including concurrent role changes.
 perform pg_advisory_xact_lock(83013001);
 if p_op='login' then
   if coalesce(p_payload->>'lineSub','')!~'^U[0-9a-fA-F]{32}$' or coalesce(p_payload->>'sessionHash','')!~'^[0-9a-f]{64}$' then raise exception 'INVALID_INPUT'; end if;
   perform pg_advisory_xact_lock(83013001);
   insert into public.attendance_employees(line_sub,name) values(p_payload->>'lineSub',left(coalesce(nullif(p_payload->>'name',''),'LINE 使用者'),80)) on conflict(line_sub) do nothing;
   select * into a from public.attendance_employees where line_sub=p_payload->>'lineSub';
   if not a.enabled then raise exception 'ACCOUNT_DISABLED'; end if;
   if a.line_sub=p_payload->>'bootstrapSub' and not exists(select 1 from public.attendance_employees where role='admin' and enabled) then
     update public.attendance_employees set role='admin' where id=a.id returning * into a;
     insert into public.attendance_audit(actor_id,action,detail) values(a.id,'建立首位管理員',jsonb_build_object('employeeId',a.id));
   end if;
   delete from public.attendance_sessions where expires_at<now();
   insert into public.attendance_sessions(hash,employee_id) values(p_payload->>'sessionHash',a.id);
   return jsonb_build_object('me',public.attendance_person(a),'expiresAt',now()+interval '30 minutes');
 end if;
 select e.* into a from public.attendance_sessions s join public.attendance_employees e on e.id=s.employee_id where s.hash=p_session_hash and s.expires_at>now();
 if not found then raise exception 'UNAUTHENTICATED'; end if;
 if not a.enabled then raise exception 'ACCOUNT_DISABLED'; end if;
 if p_op='logout' then delete from public.attendance_sessions where hash=p_session_hash; return '{"ok":true}'; end if;
 if p_op='export' then
   insert into public.attendance_audit(actor_id,action,detail) values(a.id,'匯出出勤',jsonb_build_object('from',p_payload->>'from','to',p_payload->>'to','scope',case when a.role='admin' then 'all' else 'self' end));
   return public.attendance_rpc('snapshot',p_session_hash,p_payload);
 end if;
 if p_op='snapshot' then
   v_from=coalesce((p_payload->>'from')::date,(now() at time zone 'Asia/Taipei')::date-30);
   v_to=coalesce((p_payload->>'to')::date,(now() at time zone 'Asia/Taipei')::date);
   if v_to<v_from or v_to-v_from>90 then raise exception 'INVALID_INPUT'; end if;
   select * into last_p from public.attendance_punches where employee_id=a.id order by occurred_at desc,ordinal desc limit 1;
   return jsonb_build_object(
    'me',public.attendance_person(a),'serverTime',clock_timestamp(),'currentShift',case when last_p.type='in' then public.attendance_record(last_p) else null end,
    'stats',jsonb_build_object('todayCount',(select count(distinct employee_id) from public.attendance_punches where (a.role='admin' or employee_id=a.id) and (occurred_at at time zone 'Asia/Taipei')::date=(now() at time zone 'Asia/Taipei')::date)),
    'employees',(select coalesce(jsonb_agg(public.attendance_person(e) order by e.code),'[]') from public.attendance_employees e where a.role='admin' or e.id=a.id),
    'locations',(select coalesce(jsonb_agg(jsonb_build_object('id',l.id,'name',l.name,'lat',l.lat,'lng',l.lng,'radiusMeters',l.radius_meters,'enabled',l.enabled,'version',l.version) order by l.name),'[]') from public.attendance_locations l where a.role='admin' or l.enabled),
    'records',(select coalesce(jsonb_agg(public.attendance_record(p) order by p.occurred_at,p.ordinal),'[]') from (select * from public.attendance_punches where (a.role='admin' or employee_id=a.id) and occurred_at>=(v_from::timestamp at time zone 'Asia/Taipei') and occurred_at<((v_to+1)::timestamp at time zone 'Asia/Taipei') order by occurred_at desc,ordinal desc limit 10000) p),
    'requests',(select coalesce(jsonb_agg(jsonb_build_object('id',c.id,'employeeId',c.employee_id,'type',c.type,'timestamp',c.occurred_at,'reason',c.reason,'status',c.status,'reviewNote',c.review_note,'reviewerId',c.reviewer_id) order by c.created_at desc),'[]') from (select * from public.attendance_corrections where a.role='admin' or employee_id=a.id order by created_at desc limit 1000) c),
    'audit',(select coalesce(jsonb_agg(jsonb_build_object('id',ev.id,'actorId',ev.actor_id,'action',ev.action,'detail',ev.detail,'timestamp',ev.occurred_at) order by ev.id desc),'[]') from (select * from public.attendance_audit where a.role='admin' order by id desc limit 250) ev)
   );
 end if;
 if p_op='punch' then
   perform 1 from public.attendance_employees where id=a.id for update;
   select * into r from public.attendance_punches where employee_id=a.id and idempotency_key=p_payload->>'key';
   if found then if r.fingerprint<>p_payload->>'fingerprint' then raise exception 'IDEMPOTENCY_CONFLICT'; end if; return public.attendance_record(r); end if;
   v_type=p_payload->>'type';v_accuracy=(p_payload->'position'->>'accuracy')::double precision;
   v_time=(p_payload->'position'->>'capturedAt')::timestamptz;
   if v_type not in ('in','out') or v_accuracy<0 then raise exception 'INVALID_INPUT'; end if;
   if v_time<clock_timestamp()-interval '5 minutes' or v_time>clock_timestamp()+interval '30 seconds' then raise exception 'POSITION_STALE'; end if;
   if v_accuracy>150 then raise exception 'POSITION_UNCERTAIN'; end if;
   if not exists(select 1 from public.attendance_locations where enabled) then raise exception 'NO_LOCATIONS'; end if;
   select l.* into loc from public.attendance_locations l where l.enabled and public.attendance_distance((p_payload->'position'->>'lat')::double precision,(p_payload->'position'->>'lng')::double precision,l.lat,l.lng)+v_accuracy<=l.radius_meters order by public.attendance_distance((p_payload->'position'->>'lat')::double precision,(p_payload->'position'->>'lng')::double precision,l.lat,l.lng) limit 1;
   if not found then
     if exists(select 1 from public.attendance_locations l where l.enabled and public.attendance_distance((p_payload->'position'->>'lat')::double precision,(p_payload->'position'->>'lng')::double precision,l.lat,l.lng)-v_accuracy<=l.radius_meters) then raise exception 'POSITION_UNCERTAIN'; end if;
     raise exception 'OUTSIDE_GEOFENCE';
   end if;
   v_distance=public.attendance_distance((p_payload->'position'->>'lat')::double precision,(p_payload->'position'->>'lng')::double precision,loc.lat,loc.lng);
   select * into last_p from public.attendance_punches where employee_id=a.id order by occurred_at desc,ordinal desc limit 1;
   if (v_type='in' and last_p.type='in') or (v_type='out' and (last_p.type is null or last_p.type<>'in')) then raise exception 'PUNCH_STATE_CONFLICT'; end if;
   insert into public.attendance_punches(employee_id,type,occurred_at,source,location_snapshot,distance_meters,position,idempotency_key,fingerprint) values(a.id,v_type,clock_timestamp(),'device',to_jsonb(loc),v_distance,p_payload->'position',p_payload->>'key',p_payload->>'fingerprint') returning * into r;
   insert into public.attendance_audit(actor_id,action,detail) values(a.id,'打卡',jsonb_build_object('recordId',r.id,'type',v_type));
   return public.attendance_record(r);
 end if;
 if p_op='correction' then
   v_type=p_payload->>'type';v_time=(p_payload->>'timestamp')::timestamptz;
   if v_type not in ('in','out') or v_time>clock_timestamp() or length(trim(p_payload->>'reason')) not between 3 and 500 then raise exception 'INVALID_INPUT'; end if;
   if exists(select 1 from public.attendance_corrections where employee_id=a.id and type=v_type and occurred_at=v_time and status in ('pending','approved')) then raise exception 'PUNCH_STATE_CONFLICT'; end if;
   insert into public.attendance_corrections(employee_id,type,occurred_at,reason) values(a.id,v_type,v_time,trim(p_payload->>'reason')) returning * into req;
   insert into public.attendance_audit(actor_id,action,detail) values(a.id,'申請補打卡',jsonb_build_object('requestId',req.id));
   return jsonb_build_object('id',req.id,'status','pending');
 end if;
 if a.role<>'admin' then raise exception 'FORBIDDEN'; end if;
 if p_op='review' then
   select * into req from public.attendance_corrections where id=(p_payload->>'id')::uuid;
   if not found then raise exception 'NOT_FOUND'; end if;
   if req.employee_id=a.id then raise exception 'SELF_REVIEW_FORBIDDEN'; end if;
   perform 1 from public.attendance_employees where id=req.employee_id for update;
   select * into req from public.attendance_corrections where id=req.id for update;
   if req.status<>'pending' then raise exception 'ALREADY_REVIEWED'; end if;
   if p_payload->>'decision' not in ('approved','rejected') or length(trim(p_payload->>'note')) not between 3 and 500 then raise exception 'INVALID_INPUT'; end if;
   if p_payload->>'decision'='approved' then
     if not exists(select 1 from public.attendance_employees where id=req.employee_id and enabled) then raise exception 'ACCOUNT_DISABLED'; end if;
     select exists(select 1 from (select type,lag(type) over(order by occurred_at,ordinal) prev,row_number() over(order by occurred_at,ordinal) seq from (select type,occurred_at,ordinal from public.attendance_punches where employee_id=req.employee_id union all select req.type,req.occurred_at,9223372036854775807::bigint) timeline) checked where (seq=1 and type='out') or type=prev) into v_bad;
     if v_bad then raise exception 'SEQUENCE_CONFLICT'; end if;
     insert into public.attendance_punches(employee_id,type,occurred_at,source,request_id) values(req.employee_id,req.type,req.occurred_at,'correction',req.id);
   end if;
   update public.attendance_corrections set status=p_payload->>'decision',reviewer_id=a.id,reviewed_at=clock_timestamp(),review_note=trim(p_payload->>'note') where id=req.id;
   insert into public.attendance_audit(actor_id,action,detail) values(a.id,'審核補打卡',jsonb_build_object('requestId',req.id,'decision',p_payload->>'decision','note',p_payload->>'note'));
   return '{"ok":true}';
 end if;
 if p_op='location' then
   v_id=coalesce((p_payload->>'id')::uuid,gen_random_uuid());
   if p_payload->>'id' is not null and not exists(select 1 from public.attendance_locations where id=v_id) then raise exception 'NOT_FOUND'; end if;
   insert into public.attendance_locations(id,name,lat,lng,radius_meters,enabled) values(v_id,p_payload->>'name',(p_payload->>'lat')::double precision,(p_payload->>'lng')::double precision,(p_payload->>'radiusMeters')::integer,(p_payload->>'enabled')::boolean) on conflict(id) do update set name=excluded.name,lat=excluded.lat,lng=excluded.lng,radius_meters=excluded.radius_meters,enabled=excluded.enabled,version=public.attendance_locations.version+1;
   insert into public.attendance_audit(actor_id,action,detail) values(a.id,'設定打卡地點',p_payload);
   return jsonb_build_object('id',v_id);
 end if;
 if p_op='employee' then
   perform pg_advisory_xact_lock(83013001);
   select * into target from public.attendance_employees where id=(p_payload->>'id')::uuid for update;
   if not found then raise exception 'NOT_FOUND'; end if;
   if target.role='admin' and target.enabled and (p_payload->>'role'<>'admin' or not (p_payload->>'enabled')::boolean) and not exists(select 1 from public.attendance_employees where role='admin' and enabled and id<>target.id) then raise exception 'LAST_ADMIN'; end if;
   if not (p_payload->>'enabled')::boolean then select * into last_p from public.attendance_punches where employee_id=target.id order by occurred_at desc,ordinal desc limit 1; if last_p.type='in' then raise exception 'PUNCH_STATE_CONFLICT'; end if; end if;
   update public.attendance_employees set name=p_payload->>'name',role=p_payload->>'role',enabled=(p_payload->>'enabled')::boolean where id=target.id;
   if not (p_payload->>'enabled')::boolean then delete from public.attendance_sessions where employee_id=target.id; end if;
   insert into public.attendance_audit(actor_id,action,detail) values(a.id,'設定員工權限',jsonb_build_object('before',public.attendance_person(target),'after',p_payload));
   return '{"ok":true}';
 end if;
 raise exception 'NOT_FOUND';
end;
$$;
revoke all on function public.attendance_person(public.attendance_employees),public.attendance_record(public.attendance_punches),public.attendance_distance(double precision,double precision,double precision,double precision),public.attendance_rpc(text,text,jsonb) from public,anon,authenticated;
grant execute on function public.attendance_rpc(text,text,jsonb) to service_role;
