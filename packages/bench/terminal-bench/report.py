"""What a Harbor job scored and cost (ADR 0138), from the result of each of its trials.

    python report.py jobs/<job> --summary "$GITHUB_STEP_SUMMARY"
    python report.py jobs/<job> --require-reward 1     fails unless every task scored 1 (the oracle's check)
    python report.py jobs/<job> --require-ran          fails unless the agent made a model call in every task
"""

import argparse
import json
import sys
from pathlib import Path


def trials(job: Path) -> list[dict]:
    found = []
    for path in sorted(job.glob("*/result.json")):
        try:
            result = json.loads(path.read_text())
        except (OSError, ValueError):
            continue
        if isinstance(result, dict) and result.get("task_name"):
            found.append(result)
    return found


def reward(trial: dict) -> float | None:
    rewards = (trial.get("verifier_result") or {}).get("rewards") or {}
    value = rewards.get("reward", next(iter(rewards.values()), None))
    return float(value) if isinstance(value, (int, float)) else None


def problem(trial: dict) -> str:
    encode = ((trial.get("agent_result") or {}).get("metadata") or {}).get("encode") or {}
    if encode.get("error"):
        return str(encode["error"])
    exception = trial.get("exception_info") or {}
    return str(exception.get("exception_type") or "")


def money(value: float | None) -> str:
    return "" if value is None else f"${value:.4f}"


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("job", type=Path)
    parser.add_argument("--summary", type=Path, help="a Markdown file to add the report to")
    parser.add_argument("--require-reward", type=float)
    parser.add_argument("--require-ran", action="store_true")
    args = parser.parse_args(argv)

    found = trials(args.job)
    if not found:
        print(f"No trial results under {args.job}.", file=sys.stderr)
        return 1
    rows = ["| Task | Reward | Cost | Input | Cached | Output | Calls | Problem |", "|---|---|---|---|---|---|---|---|"]
    solved = 0
    total = 0.0
    priced = True
    for trial in found:
        agent = trial.get("agent_result") or {}
        encode = (agent.get("metadata") or {}).get("encode") or {}
        score = reward(trial)
        solved += score == 1
        cost = agent.get("cost_usd")
        if isinstance(cost, (int, float)):
            total += cost
        else:
            priced = False
        problem_text = problem(trial).replace("|", "/").replace("\n", " ")[:160]
        rows.append(
            f"| {trial['task_name']} | {'' if score is None else f'{score:g}'} | {money(cost)} | "
            f"{agent.get('n_input_tokens') or 0} | {agent.get('n_cache_tokens') or 0} | {agent.get('n_output_tokens') or 0} | "
            f"{encode.get('calls') or 0} | {problem_text} |"
        )
    count = len(found)
    per_solved = f"{money(total / solved)} per solved task" if solved else "no task solved"
    spent = f"{money(total)}{'' if priced else ' (some tasks said nothing of their cost)'}"
    head = f"**{solved} of {count} solved ({100 * solved / count:.1f}%)**, {spent} spent, {per_solved}."
    report = "\n".join([f"### {args.job.name}", "", head, "", *rows, ""])
    print(report)
    if args.summary:
        with args.summary.open("a") as file:
            file.write(report + "\n")

    failed = []
    if args.require_reward is not None:
        failed += [t["task_name"] for t in found if reward(t) != args.require_reward]
    if args.require_ran:
        failed += [t["task_name"] for t in found if not ((t.get("agent_result") or {}).get("n_input_tokens") or 0)]
    if failed:
        print(f"Not as required: {', '.join(sorted(set(failed)))}.", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
