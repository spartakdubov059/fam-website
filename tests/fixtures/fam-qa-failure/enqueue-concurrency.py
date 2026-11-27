"""Two independent local PostgreSQL connections; never targets production."""
import os
import pathlib
import subprocess
import tempfile
import time

DB = "fam_qa_failure_fixture"
ROOT = pathlib.Path(__file__).resolve().parent
PSQL = ["psql", "-X", "-qAt", "-v", "ON_ERROR_STOP=1", "-d", DB]

def env(app):
    # Only a local Unix socket; do not inherit database URLs or credentials.
    return {"PATH": os.environ["PATH"], "PGHOST": "/var/run/postgresql",
            "PGAPPNAME": app, "PGOPTIONS": "-c statement_timeout=15000 -c lock_timeout=12000"}

def run(sql, app="fam_fixture_control"):
    return subprocess.run(PSQL + ["-c", sql], env=env(app), text=True,
                          capture_output=True, timeout=20, check=True).stdout.strip()

def reset():
    run("TRUNCATE private.fam_agent_inspector_signals, private.fam_agent_task_events, private.fam_agent_tasks")

def enqueue(code, event):
    return ("SELECT (public.enqueue_fam_agent_inspector_task('" + code +
            "','" + event + "',1)->>'task_created')::boolean;")

def await_condition(check, description, timeout=7):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if check():
            return
        time.sleep(0.08)
    raise AssertionError("Timed out: " + description)

def run_pair(expect_serialized, same_signal=False):
    reset()
    second_signal = "qwen_repeated_failure" if same_signal else "worker_expired_lease"
    with tempfile.TemporaryDirectory(prefix="fam-sql-race-") as directory:
        log_path = pathlib.Path(directory) / "first.log"
        with log_path.open("w") as log:
            first = subprocess.Popen(PSQL, env=env("fam_fixture_first"),
                                     stdin=subprocess.PIPE, stdout=log,
                                     stderr=subprocess.STDOUT, text=True)
            second = None
            try:
                first.stdin.write("BEGIN;\nSET ROLE service_role;\n" +
                                  enqueue("qwen_repeated_failure", "fixture:race:1") +
                                  "\n\\echo FIRST_READY\n")
                first.stdin.flush()
                await_condition(lambda: "FIRST_READY" in log_path.read_text(),
                                "first transaction inserted but not committed")
                assert "t" in log_path.read_text().splitlines(), log_path.read_text()
                second = subprocess.Popen(
                    PSQL + ["-c", "SET ROLE service_role; " +
                            enqueue(second_signal, "fixture:race:2")],
                    env=env("fam_fixture_second"), stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE, text=True)
                if expect_serialized:
                    # Confirm a real wait, rather than relying on an arbitrary sleep.
                    await_condition(lambda: run(
                        "SELECT count(*) FROM pg_stat_activity "
                        "WHERE application_name='fam_fixture_second' "
                        "AND wait_event_type='Lock' AND wait_event='advisory'") == "1",
                        "second session waiting on the transaction lock")
                else:
                    output, error = second.communicate(timeout=8)
                    assert second.returncode == 0, error
                    assert output.strip() == "t", output
                first.stdin.write("COMMIT;\n\\q\n")
                first.stdin.flush()
                first.wait(timeout=8)
                assert first.returncode == 0, log_path.read_text()
                if expect_serialized:
                    output, error = second.communicate(timeout=8)
                    assert second.returncode == 0, error
                    assert output.strip() == "f", output
                expected = "1" if expect_serialized else "2"
                assert run("SELECT count(*) FROM private.fam_agent_tasks WHERE status='queued'") == expected
                assert run("SELECT count(*) FROM private.fam_agent_task_events WHERE event_type='created'") == expected
                if expect_serialized:
                    reason = "deduped" if same_signal else "active_task"
                    assert run("SELECT outcome FROM private.fam_agent_inspector_signals WHERE event_id='fixture:race:2'") == reason
            finally:
                for process in (second, first):
                    if process is not None and process.poll() is None:
                        process.kill()
                        process.wait(timeout=5)

if __name__ == "__main__":
    run_pair(False)
    print("PASS: baseline reproduces two queued tasks for different concurrent signals", flush=True)
    run_pair(True, same_signal=True)
    print("PASS: baseline already serializes same-signature signals", flush=True)
    subprocess.run(PSQL + ["-f", str(ROOT / "enqueue-concurrency-proposed.sql")],
                   env=env("fam_fixture_control"), check=True, timeout=20)
    run_pair(True)
    run_pair(True, same_signal=True)
    print("PASS: proposed shared lock preserves single active task and same-signature dedup", flush=True)
