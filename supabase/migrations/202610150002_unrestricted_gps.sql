-- Upgrade once after 202610130001_attendance.sql. Existing records are preserved.
begin;

alter function public.attendance_rpc(text,text,jsonb) rename to attendance_rpc_geofenced_v1;
revoke all on function public.attendance_rpc_geofenced_v1(text,text,jsonb) from public,anon,authenticated,service_role;

create or replace function public.attendance_record(r public.attendance_punches)
returns jsonb language sql immutable set search_path='' as $$
 select jsonb_build_object(
  'id',r.id,'employeeId',r.employee_id,'type',r.type,'timestamp',r.occurred_at,
  'source',r.source,'locationName',coalesce(r.location_snapshot->>'name','核准補打卡'),
  'distanceMeters',r.distance_meters,'position',r.position,'requestId',r.request_id);
$$;

create function public.attendance_rpc(p_op text,p_session_hash text default null,p_payload jsonb default '{}')
returns jsonb language plpgsql security definer set search_path='' as $$
declare
 actor public.attendance_employees%rowtype;
 saved public.attendance_punches%rowtype;
 last_punch public.attendance_punches%rowtype;
 result jsonb;
 gps jsonb;
 punch_type text;
 gps_time timestamptz;
 gps_lat double precision;
 gps_lng double precision;
 gps_accuracy double precision;
begin
 -- Keep the verified login, employee scope, review rules and audit implementation.
 if p_op is distinct from 'punch' then
  result := public.attendance_rpc_geofenced_v1(p_op,p_session_hash,p_payload);
  if p_op in ('snapshot','export') then
   result := result || jsonb_build_object('attendancePolicy','unrestricted_gps');
  end if;
  return result;
 end if;

 perform pg_advisory_xact_lock(83013001);
 select e.* into actor from public.attendance_sessions s
 join public.attendance_employees e on e.id=s.employee_id
 where s.hash=p_session_hash and s.expires_at>now();
 if not found then raise exception 'UNAUTHENTICATED'; end if;
 if not actor.enabled then raise exception 'ACCOUNT_DISABLED'; end if;
 perform 1 from public.attendance_employees where id=actor.id for update;

 -- Completed retries must succeed even after their original GPS fix becomes old.
 select * into saved from public.attendance_punches
 where employee_id=actor.id and idempotency_key=p_payload->>'key';
 if found then
  if saved.fingerprint is distinct from p_payload->>'fingerprint' then
   raise exception 'IDEMPOTENCY_CONFLICT';
  end if;
  return public.attendance_record(saved);
 end if;

 punch_type := p_payload->>'type';
 gps := p_payload->'position';
 if punch_type is null or punch_type not in ('in','out')
  or coalesce(jsonb_typeof(gps),'')<>'object'
  or coalesce(jsonb_typeof(gps->'lat'),'')<>'number'
  or coalesce(jsonb_typeof(gps->'lng'),'')<>'number'
  or coalesce(jsonb_typeof(gps->'accuracy'),'')<>'number'
  or coalesce(jsonb_typeof(gps->'capturedAt'),'')<>'string'
  or length(coalesce(gps->>'capturedAt',''))=0
  or length(coalesce(p_payload->>'key','')) not between 1 and 128
  or length(coalesce(p_payload->>'fingerprint',''))<>64 then
  raise exception 'INVALID_INPUT';
 end if;
 gps_lat := (gps->>'lat')::double precision;
 gps_lng := (gps->>'lng')::double precision;
 gps_accuracy := (gps->>'accuracy')::double precision;
 gps_time := (gps->>'capturedAt')::timestamptz;
 if not (gps_lat between -90 and 90) or not (gps_lng between -180 and 180)
  or gps_accuracy<0 then raise exception 'INVALID_INPUT'; end if;
 if gps_time<clock_timestamp()-interval '5 minutes'
  or gps_time>clock_timestamp()+interval '30 seconds' then
  raise exception 'POSITION_STALE';
 end if;
 if gps_accuracy>150 then raise exception 'POSITION_UNCERTAIN'; end if;

 -- GPS is recorded, but neither an office location nor a radius is required.
 select * into last_punch from public.attendance_punches
 where employee_id=actor.id order by occurred_at desc,ordinal desc limit 1;
 if (punch_type='in' and last_punch.type='in')
  or (punch_type='out' and (last_punch.type is null or last_punch.type<>'in')) then
  raise exception 'PUNCH_STATE_CONFLICT';
 end if;
 insert into public.attendance_punches(
  employee_id,type,occurred_at,source,location_snapshot,position,idempotency_key,fingerprint
 ) values (
  actor.id,punch_type,clock_timestamp(),'device',
  jsonb_build_object('name','不限範圍','mode','unrestricted_gps'),
  jsonb_build_object('lat',gps_lat,'lng',gps_lng,'accuracy',gps_accuracy,'capturedAt',gps_time),
  p_payload->>'key',p_payload->>'fingerprint'
 ) returning * into saved;
 insert into public.attendance_audit(actor_id,action,detail)
 values(actor.id,'打卡',jsonb_build_object('recordId',saved.id,'type',punch_type,'mode','unrestricted_gps'));
 return public.attendance_record(saved);
end;
$$;

revoke all on function public.attendance_record(public.attendance_punches),public.attendance_rpc(text,text,jsonb)
 from public,anon,authenticated;
grant execute on function public.attendance_rpc(text,text,jsonb) to service_role;
notify pgrst, 'reload schema';
commit;
