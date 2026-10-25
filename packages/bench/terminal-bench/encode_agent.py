"""eNCode's command line as a Harbor agent, for Terminal-Bench (ADR 0138).

Harbor starts each task's container, installs the agent in it, gives it the task's instruction, then runs the task's
tests. This agent copies eNCode's command line in as one file (``node scripts/cli-bundle.mjs <out>``) and runs it in
print mode on the instruction, with the model and spending cap it is given:

    PYTHONPATH=packages/bench/terminal-bench harbor run -d terminal-bench/terminal-bench@4.0.0 \\
        -a encode_agent:Encode -m openrouter/<model> --ak effort=max --ak max_cost=0.10

The model's key is read on the machine that runs Harbor (``OPENROUTER_API_KEY`` and so on) and is given to the command
line alone, which keeps it from the commands its agent runs. Node 22 comes from the task's image when it has one;
otherwise the node binary that runs here is copied in, so nothing is downloaded into the task.
"""

import json
import shlex
import shutil
from pathlib import Path
from typing import Annotated, Literal, override

from pydantic import Field

from harbor.agents.installed.base import BaseInstalledAgent, with_prompt_template
from harbor.agents.options import Cli, InstalledAgentOptions
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext

HERE = Path(__file__).resolve().parent

# The providers the command line knows, and the key each one reads.
KEYS = {
    "openrouter": "OPENROUTER_API_KEY",
    "anthropic": "ANTHROPIC_API_KEY",
    "openai": "OPENAI_API_KEY",
    "deepseek": "DEEPSEEK_API_KEY",
    "ollama": None,
    "lmstudio": None,
}
NODE_MAJOR = 22


def encode_model(name: str) -> str:
    """Harbor's ``provider/model`` as the command line's ``provider:model``; ``demo`` and ``@free`` as they are."""
    if name in ("demo", "@free") or ":" in name.split("/")[0]:
        return name
    provider, _, model = name.partition("/")
    if provider not in KEYS or not model:
        raise ValueError(
            f"eNCode cannot run the model {name!r}: give it as <provider>/<model>, with a provider of "
            f"{', '.join(KEYS)}, or as demo"
        )
    return f"{provider}:{model}"


class EncodeOptions(InstalledAgentOptions):
    effort: Annotated[Literal["low", "medium", "high", "xhigh", "max"] | None, Cli("--effort")] = Field(
        default=None, description="How long a reasoning model thinks (default: its own)."
    )
    max_cost: Annotated[float | None, Cli("--max-cost")] = Field(
        default=None,
        gt=0,
        le=1000,
        description="Dollars one task may spend: the run stops before a model call could take it past this.",
    )
    max_steps: Annotated[int | None, Cli("--max-steps")] = Field(
        default=None, ge=1, le=1000, description="Steps for the task (the command line's default is 200)."
    )
    bundle: str | None = Field(
        default=None,
        description="The command line as one file on this machine (default: dist/encode.mjs next to this module).",
    )
    node: str | None = Field(
        default=None,
        description="A Node 22 binary to copy into a task whose image has none (default: the node on PATH).",
    )


class Encode(BaseInstalledAgent):
    """eNCode's command line in print mode, with full access inside the task's container."""

    options_model = EncodeOptions

    # Where it goes in the task's container. Class attributes, so a test can put it elsewhere.
    home = "/installed-agent/encode"
    _node: str | None = None

    @staticmethod
    @override
    def name() -> str:
        return "encode"

    @property
    def bundle_path(self) -> str:
        return f"{self.home}/encode.mjs"

    def _host_file(self, given: str | None, default: Path | None, what: str, hint: str) -> Path:
        path = Path(given).expanduser() if given else default
        if path is None or not path.is_file():
            raise FileNotFoundError(f"{what} not found{f' at {path}' if path else ''}: {hint}")
        return path.resolve()

    @override
    def get_version_command(self) -> str | None:
        if not self._node:
            return None
        return f"{shlex.quote(self._node)} {shlex.quote(self.bundle_path)} --version"

    @override
    def parse_version(self, stdout: str) -> str:
        return stdout.strip().removeprefix("eNCode").strip()

    async def _image_node(self, environment: BaseEnvironment) -> str | None:
        """The task image's own node, when it is Node 22 or later."""
        check = (
            "command -v node >/dev/null 2>&1 && "
            f"node -e 'process.exit(Number(process.versions.node.split(\".\")[0]) >= {NODE_MAJOR} ? 0 : 1)' && "
            "command -v node"
        )
        found = await environment.exec(command=check)
        path = (found.stdout or "").strip().splitlines()
        return path[-1] if found.return_code == 0 and path else None

    @override
    async def install(self, environment: BaseEnvironment) -> None:
        bundle = self._host_file(
            self.options.bundle,
            HERE / "dist" / "encode.mjs",
            "eNCode's command line",
            "build it with node scripts/cli-bundle.mjs packages/bench/terminal-bench/dist/encode.mjs",
        )
        home = shlex.quote(self.home)
        await self.ensure_system_dependencies(environment, ("bash",))
        await self.exec_as_root(environment, f"mkdir -p {home}")
        await environment.upload_file(bundle, self.bundle_path)
        await self.exec_as_root(environment, f"chmod 755 {home} && chmod 644 {shlex.quote(self.bundle_path)}")

        self._node = await self._image_node(environment)
        if self._node:
            return
        here = shutil.which("node")
        node = self._host_file(self.options.node, Path(here) if here else None, "Node", "pass --ak node=<path>")
        copied = f"{self.home}/node"
        await environment.upload_file(node, copied)
        await self.exec_as_root(environment, f"chmod 755 {shlex.quote(copied)}")
        ran = await environment.exec(command=f"{shlex.quote(copied)} --version")
        if ran.return_code == 0:
            self._node = copied
            return
        # Node's own builds need glibc; an Alpine image gets its own package of Node.
        await self.exec_as_root(environment, "command -v apk >/dev/null 2>&1 && apk add --no-cache nodejs")
        self._node = await self._image_node(environment)
        if not self._node:
            raise RuntimeError(f"This task's image cannot run Node {NODE_MAJOR}, which eNCode's command line needs.")

    def _flags(self) -> str:
        # Full access inside the task's container, which is the sandbox; there is no one to approve anything.
        return " ".join(["--policy full-access --no-sandbox --trust", self.build_cli_flags()]).strip()

    @override
    @with_prompt_template
    async def run(self, instruction: str, environment: BaseEnvironment, context: AgentContext) -> None:
        if not self.model_name:
            raise ValueError("eNCode needs a model: -m openrouter/<model>, or -m demo")
        if not self._node:
            raise RuntimeError("eNCode is not installed in this task's container")
        model = encode_model(self.model_name)
        provider = model.split(":")[0]
        key_name = KEYS.get(provider)
        env: dict[str, str] = {}
        if key_name:
            key = self._get_env(key_name)
            if not key:
                raise ValueError(f"{key_name} is not set on the machine that runs Harbor")
            env[key_name] = key

        logs = shlex.quote(str(self.environment_logs_dir))
        command = (
            f"{shlex.quote(self._node)} {shlex.quote(self.bundle_path)} -p --model {shlex.quote(model)} "
            f"{self._flags()} --output-format json --verbose {shlex.quote(instruction)} "
            f"< /dev/null > {logs}/encode-result.json 2> {logs}/encode.txt; "
            "status=$?; "
            # The session, every step of it, comes back with the logs.
            f'mkdir -p {logs}/sessions && cp -R "$HOME/.encode/cli/sessions/." {logs}/sessions/ 2>/dev/null; '
            "exit $status"
        )
        await self.exec_as_agent(environment, command=command, env=env)

    @override
    def populate_context_post_run(self, context: AgentContext) -> None:
        try:
            result = json.loads((self.logs_dir / "encode-result.json").read_text())
        except (OSError, ValueError):
            return
        if not isinstance(result, dict):
            return
        usage = result.get("usage") if isinstance(result.get("usage"), dict) else {}
        context.n_input_tokens = int(usage.get("inputTokens") or 0)
        context.n_cache_tokens = int(usage.get("cachedTokens") or 0)
        context.n_output_tokens = int(usage.get("outputTokens") or 0)
        cost = usage.get("cost")
        context.cost_usd = float(cost) if isinstance(cost, (int, float)) else None
        context.metadata = {
            **(context.metadata or {}),
            "encode": {
                "ok": result.get("ok"),
                "error": result.get("error"),
                "model": result.get("model"),
                "calls": usage.get("calls"),
                "duration_ms": result.get("durationMs"),
                "session": result.get("session"),
            },
        }
