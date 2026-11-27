"""Rehearse a four-function forward/rollback transaction against synthetic data only."""
import json
import subprocess
from enqueue_concurrency import PSQL, ROOT, env, run

SIGNATURES = (
    "public.advance_fam_agent_coder_task(uuid,text,text,integer)",
    "public.claim_fam_agent_coder_tasks(text,integer,integer)",
    "public.enqueue_fam_agent_inspector_task(text,text,integer)",
    "private.enqueue_fam_agent_coder_task()",
)

def state():
    entries = ",".join("('" + s + "'::regprocedure)" for s in SIGNATURES)
    return json.loads(run("SELECT jsonb_agg(jsonb_build_object("
        "'signature',v.sig::text,'definition',pg_get_functiondef(p.oid),"
        "'owner',pg_get_userbyid(p.proowner),'acl',p.proacl::text,"
        "'definer',p.prosecdef,'config',p.proconfig,"
        "'anon',has_function_privilege('anon',p.oid,'EXECUTE'),"
        "'authenticated',has_function_privilege('authenticated',p.oid,'EXECUTE'),"
        "'service',has_function_privilege('service_role',p.oid,'EXECUTE')) ORDER BY v.sig::text) "
        "FROM (VALUES " + entries + ") v(sig) JOIN pg_proc p ON p.oid=v.sig"))

def rows():
    return run("SELECT jsonb_build_object("
        "'tasks',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM private.fam_agent_tasks t),"
        "'events',(SELECT jsonb_agg(to_jsonb(e) ORDER BY to_jsonb(e)::text) FROM private.fam_agent_task_events e),"
        "'signals',(SELECT jsonb_agg(to_jsonb(s) ORDER BY event_id) FROM private.fam_agent_inspector_signals s))")

def apply(filename):
    subprocess.run(PSQL + ["--single-transaction", "-f", str(ROOT / filename)],
        env=env("fam_fixture_rollout"), check=True, timeout=25)

def no_body(entries):
    return [{k:v for k,v in item.items() if k != "definition"} for item in entries]

if __name__ == "__main__":
    # All definitions previously installed by preceding synthetic tests.
    current = state()
    assert len(current) == 4
    saved_rows = rows()
    apply("rollout-baseline.sql")
    original = state()
    assert rows() == saved_rows
    assert no_body(original) == no_body(current)
    assert all(not r["anon"] and not r["authenticated"] and r["service"] for r in original)
    assert all(a["definition"] != b["definition"] for a,b in zip(original,current))
    apply("rollout-forward.sql")
    assert state() == current
    assert rows() == saved_rows
    apply("rollout-baseline.sql")
    assert state() == original
    assert rows() == saved_rows
    apply("rollout-forward.sql")
    assert state() == current
    assert rows() == saved_rows
    print("PASS: exact four-function forward, rollback and reapply preserve ACL, owners, settings and every fixture row", flush=True)
