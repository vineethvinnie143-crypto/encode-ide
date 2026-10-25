"""The Harbor agent for eNCode (ADR 0138), against a container that is a folder on this machine.

    node scripts/cli-bundle.mjs packages/bench/terminal-bench/dist/encode.mjs
    python -m unittest discover -s packages/bench/terminal-bench

Needs harbor installed (pip install harbor==0.25.0) and Node 22.
"""

import asyncio
import json
import os
import shutil
import subprocess
import tempfile
import unittest
from dataclasses import dataclass
from pathlib import Path, PurePosixPath

from harbor.models.agent.context import AgentContext

from encode_agent import Encode, encode_model

HERE = Path(__file__).resolve().parent
BUNDLE = HERE / "dist" / "encode.mjs"


@dataclass
class Ran:
    return_code: int
    stdout: str = ""
    stderr: str = ""


class FolderEnvironment:
    """What the agent uses of a Harbor environment: commands run in a folder here, files are copied."""

    default_user = None

    def __init__(self, root: Path, path: str | None = None, run: bool = True):
        self.workdir = root / "app"
        self.workdir.mkdir(parents=True, exist_ok=True)
        self.home = root / "home"
        self.home.mkdir(exist_ok=True)
        self.path = path
        self.run = run
        self.commands: list[tuple[str, dict[str, str] | None]] = []
        self.uploads: list[str] = []

    async def exec(self, command, user=None, env=None, cwd=None, timeout_sec=None):
        self.commands.append((command, env))
        if not self.run:
            return Ran(0)
        full = {**os.environ, "HOME": str(self.home), **(env or {})}
        if self.path is not None:
            full["PATH"] = self.path
        done = subprocess.run(
            ["bash", "-c", command], cwd=cwd or self.workdir, env=full, capture_output=True, text=True, timeout=120
        )
        return Ran(done.returncode, done.stdout, done.stderr)

    async def upload_file(self, source_path, target_path):
        self.uploads.append(target_path)
        Path(target_path).parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source_path, target_path)


def agent(root: Path, model: str = "demo", **options) -> Encode:
    logs = root / "logs"
    logs.mkdir(exist_ok=True)
    made = Encode(logs_dir=logs, model_name=model, environment_logs_dir=PurePosixPath(logs), **options)
    made.home = str(root / "installed-agent")
    return made


class EncodeModelTest(unittest.TestCase):
    def test_names(self):
        self.assertEqual(encode_model("openrouter/@preset/deepseek-v4-1-1017"), "openrouter:@preset/deepseek-v4-1-1017")
        self.assertEqual(encode_model("openrouter/deepseek/deepseek-v4.1-flash"), "openrouter:deepseek/deepseek-v4.1-flash")
        self.assertEqual(encode_model("openrouter:deepseek/x"), "openrouter:deepseek/x")
        self.assertEqual(encode_model("demo"), "demo")
        self.assertEqual(encode_model("@free"), "@free")
        with self.assertRaisesRegex(ValueError, "cannot run the model 'gemini/x'"):
            encode_model("gemini/x")
        with self.assertRaises(ValueError):
            encode_model("openrouter/")


@unittest.skipUnless(BUNDLE.is_file(), f"build {BUNDLE} first")
class InstalledTest(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix="encode-agent-"))
        self.addCleanup(shutil.rmtree, self.root, True)

    def test_installs_runs_a_task_and_reports_what_it_used(self):
        env = FolderEnvironment(self.root)
        made = agent(self.root)
        asyncio.run(made.setup(env))
        self.assertEqual(made.version(), "0.1.0")
        self.assertNotIn(f"{made.home}/node", env.uploads, "the image's own Node 22 is used")

        context = AgentContext()
        asyncio.run(made.run("Say hello.", env, context))
        made.populate_context_post_run(context)
        result = json.loads((self.root / "logs" / "encode-result.json").read_text())
        self.assertEqual(result["model"], "demo (offline)")
        self.assertGreater(context.n_input_tokens, 0)
        self.assertEqual(context.metadata["encode"]["session"], result["session"])
        self.assertTrue((self.root / "logs" / "sessions" / f"{result['session']}.jsonl").is_file())
        self.assertTrue((self.root / "logs" / "encode.txt").is_file())

    def test_copies_node_into_an_image_without_it(self):
        env = FolderEnvironment(self.root, path="/usr/bin:/bin")
        if shutil.which("node", path=env.path):
            self.skipTest("node is in /usr/bin here")
        made = agent(self.root)
        asyncio.run(made.setup(env))
        self.assertEqual(made._node, f"{made.home}/node")
        self.assertIn(f"{made.home}/node", env.uploads)
        self.assertEqual(made.version(), "0.1.0")


class CommandTest(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix="encode-agent-"))
        self.addCleanup(shutil.rmtree, self.root, True)

    def ready(self, model: str, **options) -> tuple[Encode, FolderEnvironment]:
        made = agent(self.root, model, **options)
        made._node = "/usr/bin/node"
        return made, FolderEnvironment(self.root, run=False)

    def test_gives_the_model_its_key_alone_with_the_effort_and_the_cap(self):
        made, env = self.ready(
            "openrouter/@preset/deepseek-v4-1-1017",
            extra_env={"OPENROUTER_API_KEY": "test-key", "ANTHROPIC_API_KEY": "other"},
            effort="max",
            max_cost="0.10",
            max_steps=50,
        )
        asyncio.run(made.run("Fix the build.", env, AgentContext()))
        command, given = env.commands[-1]
        self.assertEqual(given, {"OPENROUTER_API_KEY": "test-key"})
        self.assertIn("--model openrouter:@preset/deepseek-v4-1-1017 ", command)
        self.assertIn("--policy full-access --no-sandbox --trust --effort max --max-cost 0.1 --max-steps 50 ", command)
        self.assertIn("--output-format json --verbose 'Fix the build.' < /dev/null", command)
        self.assertNotIn("test-key", command)

    def test_refuses_what_it_cannot_run(self):
        made, env = self.ready("openrouter/x")
        saved = os.environ.pop("OPENROUTER_API_KEY", None)
        self.addCleanup(lambda: saved is not None and os.environ.__setitem__("OPENROUTER_API_KEY", saved))
        with self.assertRaisesRegex(ValueError, "OPENROUTER_API_KEY is not set"):
            asyncio.run(made.run("x", env, AgentContext()))
        # Wrong options stop Harbor before a task is queued.
        with self.assertRaisesRegex(ValueError, "effort"):
            agent(self.root, "demo", effort="extreme")
        with self.assertRaisesRegex(ValueError, "max_cost"):
            agent(self.root, "demo", max_cost="0")
        self.assertEqual(env.commands, [])

    def test_reads_no_result_as_nothing_known(self):
        made, _ = self.ready("demo")
        context = AgentContext()
        made.populate_context_post_run(context)
        self.assertIsNone(context.n_input_tokens)
        (self.root / "logs" / "encode-result.json").write_text(
            json.dumps({"ok": True, "usage": {"inputTokens": 1200, "cachedTokens": 900, "outputTokens": 80, "cost": 0.0021, "calls": 3}})
        )
        made.populate_context_post_run(context)
        self.assertEqual((context.n_input_tokens, context.n_cache_tokens, context.n_output_tokens), (1200, 900, 80))
        self.assertEqual(context.cost_usd, 0.0021)
        self.assertEqual(context.metadata["encode"]["calls"], 3)


if __name__ == "__main__":
    unittest.main()
