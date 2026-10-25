"""Choosing a run's tasks and reporting what it scored (ADR 0138)."""

import contextlib
import io
import json
import shutil
import tempfile
import unittest
from pathlib import Path

import choose_tasks
import report


def run(main, *argv: str) -> tuple[int, str, str]:
    out, err = io.StringIO(), io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        code = main(list(argv))
    return code, out.getvalue(), err.getvalue()


class ChooseTasksTest(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix="tb-tasks-"))
        self.addCleanup(shutil.rmtree, self.root, True)
        tasks = {
            "fix-git": "",
            "build-server": "cpus = 2\nmemory_mb = 4096",
            "train-model": "gpus = 1",
            "big-sql": "memory_mb = 65536",
            "win-only": 'os = "windows"',
            "count-words": "",
        }
        for name, environment in tasks.items():
            folder = self.root / "terminal-bench" / name
            folder.mkdir(parents=True)
            (folder / "task.toml").write_text(f'schema_version = "1.4"\n\n[environment]\n{environment}\n')

    def test_leaves_out_what_this_machine_cannot_run_and_samples_the_rest(self):
        code, out, _ = run(choose_tasks.main, str(self.root))
        self.assertEqual(code, 0)
        self.assertEqual(out.split(), ["*/build-server", "*/count-words", "*/fix-git"])
        summary = self.root / "summary.md"
        code, first, _ = run(choose_tasks.main, str(self.root), "--sample", "2", "--seed", "7", "--summary", str(summary))
        self.assertEqual(code, 0)
        self.assertEqual(len(first.split()), 2)
        self.assertEqual(run(choose_tasks.main, str(self.root), "--sample", "2", "--seed", "7")[1], first, "the same seed")
        text = summary.read_text()
        self.assertIn("### Tasks: 2 of 6", text)
        self.assertIn("- train-model: needs 1 GPU", text)
        self.assertIn("- big-sql: needs 65536 MB of memory", text)
        self.assertIn("- win-only: runs on windows", text)

    def test_runs_the_tasks_named_and_refuses_those_it_cannot(self):
        self.assertEqual(run(choose_tasks.main, str(self.root), "--names", "fix-git count-words")[1].split(), ["*/fix-git", "*/count-words"])
        code, _, err = run(choose_tasks.main, str(self.root), "--names", "fix-git train-model nothing")
        self.assertEqual(code, 2)
        self.assertIn("Cannot run: nothing, train-model (needs 1 GPU).", err)
        self.assertEqual(run(choose_tasks.main, str(self.root), "--sample", "4")[0], 2)


class ReportTest(unittest.TestCase):
    def setUp(self):
        self.job = Path(tempfile.mkdtemp(prefix="tb-job-"))
        self.addCleanup(shutil.rmtree, self.job, True)
        (self.job / "result.json").write_text(json.dumps({"id": "job", "n_total_trials": 2}))

    def trial(self, name: str, reward, cost, error=None, tokens=1000):
        folder = self.job / f"{name.split('/')[-1]}__abc"
        folder.mkdir()
        agent = {"n_input_tokens": tokens, "n_cache_tokens": tokens // 2, "n_output_tokens": 40, "cost_usd": cost}
        agent["metadata"] = {"encode": {"calls": 3, "error": error}}
        verifier = None if reward is None else {"rewards": {"reward": reward}}
        (folder / "result.json").write_text(json.dumps({"task_name": name, "agent_result": agent, "verifier_result": verifier}))

    def test_says_what_was_solved_and_what_it_cost(self):
        self.trial("terminal-bench/fix-git", 1, 0.031)
        self.trial("terminal-bench/count-words", 0, 0.1, error="Stopped: it reached its spending cap ($0.09 of $0.10 spent; the next call could cost $0.01).")
        summary = self.job / "summary.md"
        code, out, _ = run(report.main, str(self.job), "--summary", str(summary))
        self.assertEqual(code, 0)
        self.assertIn("**1 of 2 solved (50.0%)**, $0.1310 spent, $0.1310 per solved task.", out)
        self.assertIn("| terminal-bench/fix-git | 1 | $0.0310 | 1000 | 500 | 40 | 3 |  |", out)
        self.assertIn("Stopped: it reached its spending cap", out)
        self.assertEqual(summary.read_text().strip(), out.strip())

    def test_fails_a_requirement_it_does_not_meet(self):
        self.trial("smoke-task", 0, None, tokens=0)
        code, out, err = run(report.main, str(self.job), "--require-reward", "1")
        self.assertEqual(code, 1)
        self.assertIn("(some tasks said nothing of their cost)", out)
        self.assertIn("Not as required: smoke-task.", err)
        self.assertEqual(run(report.main, str(self.job), "--require-ran")[0], 1)
        self.assertEqual(run(report.main, str(self.job / "nothing"))[0], 1)


if __name__ == "__main__":
    unittest.main()
