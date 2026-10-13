import { createHandler } from './handler.mjs';
const env = Object.fromEntries(['LINE_CHANNEL_ID','SUPABASE_URL','SUPABASE_SERVICE_ROLE_KEY','SUPABASE_SECRET_KEYS','DATABASE_SECRET_KEY','ALLOWED_ORIGINS','BOOTSTRAP_LINE_SUB'].map(key=>[key,Deno.env.get(key)||'']));
Deno.serve(createHandler({env}));
