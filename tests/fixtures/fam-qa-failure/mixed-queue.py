"""Exercise three cooperating queue entry points, using synthetic data and local socket only."""
import pathlib
import subprocess
import tempfile
from enqueue_concurrency import PSQL, ROOT, env, run, reset, enqueue, await_condition

CLAIM = "SELECT count(*)=1 FROM public.claim_fam_agent_coder_tasks('fam-agent-qwen-coder-v1',1,7200);"
PRODUCE = "SELECT (private.enqueue_fam_agent_coder_task()->>'task_created')::boolean;"
INSPECT = enqueue("worker_expired_lease", "fixture:mixed:2")
ACTIVE = "SELECT count(*) FROM private.fam_agent_tasks WHERE status IN ('queued','claimed','in_progress')"

def apply(filename):
    subprocess.run(PSQL + ["-f", str(ROOT / filename)], env=env("fam_fixture_control"),
                   check=True, timeout=20)

def seed_failures(count):
    assert count in (1, 2)
    run("INSERT INTO private.fam_agent_tasks "
        "(agent_key,task_type,approval_required,source,status,attempt_count,result_summary,created_at) "
        "SELECT 'technical','coder_patch_request',false,'scheduled_audit','failed',1,"
        "'Локальный анализатор завершился с ошибкой.', now()-i*interval '1 hour' "
        "FROM generate_series(1," + str(count) + ") i")

def pair(first_sql, second_sql, serialized):
    with tempfile.TemporaryDirectory(prefix="fam-mixed-race-") as directory:
        log_path = pathlib.Path(directory) / "first.log"
        with log_path.open("w") as log:
            first = subprocess.Popen(PSQL, env=env("fam_fixture_first"), stdin=subprocess.PIPE,
                                     stdout=log, stderr=subprocess.STDOUT, text=True)
            second = None
            try:
                first.stdin.write("BEGIN;\nSET ROLE service_role;\n" + first_sql + "\n\\echo FIRST_READY\n")
                first.stdin.flush()
                await_condition(lambda: "FIRST_READY" in log_path.read_text(), "first transaction ready")
                assert "t" in log_path.read_text().splitlines(), log_path.read_text()
                second = subprocess.Popen(PSQL + ["-c", "SET ROLE service_role; " + second_sql],
                                          env=env("fam_fixture_second"), stdout=subprocess.PIPE,
                                          stderr=subprocess.PIPE, text=True)
                if serialized:
                    await_condition(lambda: run(
                        "SELECT count(*) FROM pg_stat_activity WHERE application_name='fam_fixture_second' "
                        "AND wait_event_type='Lock' AND wait_event='advisory'") == "1", "shared lock wait")
                else:
                    output, err = second.communicate(timeout=8)
                    assert second.returncode == 0, err
                    assert output.strip() == "t", output
                first.stdin.write("COMMIT;\n\\q\n")
                first.stdin.flush()
                first.wait(timeout=8)
                assert first.returncode == 0, log_path.read_text()
                if serialized:
                    output, err = second.communicate(timeout=8)
                    assert second.returncode == 0, err
                    assert output.strip() == "f", output
                assert run(ACTIVE) == ("1" if serialized else "2")
            finally:
                for process in (second, first):
                    if process is not None and process.poll() is None:
                        process.kill()
                        process.wait(timeout=5)

def test_mixed(serialized):
    reset()
    seed_failures(1)
    pair(CLAIM, INSPECT, serialized)
    reset()
    pair(INSPECT, PRODUCE, serialized)
    reset()
    pair(PRODUCE, INSPECT, serialized)

def test_retry_budget(fixed):
    reset()
    seed_failures(2)
    assert run("SET ROLE service_role; " + CLAIM) == "t"
    assert run(ACTIVE) == ("1" if fixed else "2")
    if fixed:
        assert run("SELECT count(*) FROM private.fam_agent_task_events WHERE event_type='retry_scheduled'") == "1"
        assert run("SET ROLE service_role; " + CLAIM) == "f"
        assert run("SELECT count(*) FROM private.fam_agent_tasks WHERE status='failed'") == "1"

if __name__ == "__main__":
    # The preceding test already installed the proposed shared INSPECTOR lock.
    run("CREATE TABLE private.fam_site_error_counts (hour_bucket timestamptz,event_code text,page_area text,event_count integer); "
        "INSERT INTO private.fam_site_error_counts VALUES (now(),'js_runtime','other',3); "
        "GRANT SELECT ON private.fam_site_error_counts TO service_role;")
    apply("producer-baseline.sql")
    test_mixed(False)
    test_retry_budget(False)
    print("PASS: baseline mixed entry-point races and multiple failure requeue reproduced", flush=True)
    apply("claim-producer-proposed.sql")
    test_mixed(True)
    test_retry_budget(True)
    assert run("SELECT has_function_privilege('anon','private.enqueue_fam_agent_coder_task()','EXECUTE')") == "f"
    assert run("SELECT has_function_privilege('authenticated','public.claim_fam_agent_coder_tasks(text,integer,integer)','EXECUTE')") == "f"
    print("PASS: three cooperating entry points share lock; only one eligible retry; active task prevents extra claim", flush=True)
