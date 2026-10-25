"""Which Terminal-Bench tasks a run takes (ADR 0138): those this machine can run, a sample of them, or the ones named.

    harbor download terminal-bench/terminal-bench@4.0.0 -o tasks
    python choose_tasks.py tasks --sample 10 --seed 1 --summary "$GITHUB_STEP_SUMMARY"

Prints one ``-i`` pattern per line for ``harbor run``. A task that needs a GPU, another system, or more processors or
memory than the machine has is left out, and the summary says which and why: a task that cannot start would count as
failed and say nothing about the agent.
"""

import argparse
import random
import sys
import tomllib
from pathlib import Path


def read_tasks(root: Path) -> dict[str, dict]:
    tasks: dict[str, dict] = {}
    for config in sorted(root.rglob("task.toml")):
        with config.open("rb") as file:
            tasks[config.parent.name] = tomllib.load(file)
    return tasks


def why_not(config: dict, cpus: float, memory_mb: int) -> str | None:
    environment = config.get("environment") or {}
    if (environment.get("gpus") or 0) > 0:
        return f"needs {environment['gpus']} GPU"
    if environment.get("tpu"):
        return "needs a TPU"
    if (environment.get("os") or "linux") != "linux":
        return f"runs on {environment['os']}"
    if (environment.get("cpus") or 0) > cpus:
        return f"needs {environment['cpus']} processors"
    if (environment.get("memory_mb") or 0) > memory_mb:
        return f"needs {environment['memory_mb']} MB of memory"
    return None


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("root", type=Path, help="the downloaded dataset")
    parser.add_argument("--sample", type=int, help="this many tasks, chosen at random")
    parser.add_argument("--seed", type=int, default=1, help="the same seed chooses the same tasks")
    parser.add_argument("--names", default="", help="these tasks instead, separated by spaces")
    parser.add_argument("--cpus", type=float, default=4)
    parser.add_argument("--memory-mb", type=int, default=15_000)
    parser.add_argument("--summary", type=Path, help="a Markdown file to add what was chosen to")
    args = parser.parse_args(argv)

    tasks = read_tasks(args.root)
    if not tasks:
        print(f"No tasks under {args.root}.", file=sys.stderr)
        return 2
    left_out = {name: why for name, config in tasks.items() if (why := why_not(config, args.cpus, args.memory_mb))}
    runnable = sorted(name for name in tasks if name not in left_out)

    named = args.names.split()
    if named:
        unknown = [name for name in named if name not in tasks]
        refused = [f"{name} ({left_out[name]})" for name in named if name in left_out]
        if unknown or refused:
            print(f"Cannot run: {', '.join(unknown + refused)}.", file=sys.stderr)
            return 2
        chosen = named
    elif args.sample:
        if args.sample > len(runnable):
            print(f"Only {len(runnable)} tasks can run here, not {args.sample}.", file=sys.stderr)
            return 2
        chosen = sorted(random.Random(args.seed).sample(runnable, args.sample))
    else:
        chosen = runnable

    if args.summary:
        lines = [
            f"### Tasks: {len(chosen)} of {len(tasks)}",
            "",
            f"{len(runnable)} can run on this machine. Chosen: {', '.join(chosen)}.",
            "",
        ]
        if left_out:
            lines += ["Left out:", ""] + [f"- {name}: {why}" for name, why in sorted(left_out.items())] + [""]
        with args.summary.open("a") as file:
            file.write("\n".join(lines) + "\n")
    # Harbor names a dataset's tasks <org>/<task>.
    print("\n".join(f"*/{name}" for name in chosen))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
