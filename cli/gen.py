"""`cli gen --process <id>` -- invoke the codegen skill to emit an agent.

A model runs in this path. That is deliberate: picking a template per node and
filling it from config is judgment, and judgment is what a skill is for.

**Say the cost plainly rather than burying it.** Because a model writes the
file, the same frozen spec can produce different code across two runs.
`spec_hash` still identifies the *input* exactly, and `verify_generated.py`
still constrains the *output*, but byte-identical regeneration is not a property
this system has. What replaces it is the lint: imports resolve only to
`runtime.*` and stdlib, no runtime verb is redefined, and any function the module
defines is byte-identical to an `impl.body` in the spec. Fail the lint,
regenerate; never patch.

## The context firewall

The skill runs in a scratch directory containing exactly three files:

    spec.json        the frozen spec
    RUNTIME_API.md   signatures and one-line docs, generated from the modules
    TEMPLATES.md     the twelve shapes, with synthetic examples only

Not the README. Not the design document. Not the conversation that produced the
board. Not the process's own fixtures or expected results. If the skill needs
domain context to emit correct code, the spec is insufficient -- which is
precisely the property under test, and it cannot be tested if the context leaks.

The isolation is a working directory, not a sandbox: a `claude` invocation still
carries the user's own global configuration. That is a real limit and it is
worth knowing rather than assuming otherwise.
"""
from __future__ import annotations

import json
import shutil
import subprocess
import tempfile
from pathlib import Path

from runtime.spec import Spec

from .paths import agent_dir, spec_path
from .surface import surface
from .verify_generated import verify

SKILL_DIR = Path(__file__).resolve().parents[1] / "skills" / "spec-to-agent"
MAX_ATTEMPTS = 3

PROMPT = """Use the spec-to-agent skill to generate an agent.

Your working directory holds exactly three files, and they are your only input:

  spec.json        the frozen spec you are generating from
  RUNTIME_API.md   the only verbs your code may call
  TEMPLATES.md     the shapes to emit

Read all three, then write `agent.py` into this directory.

Do not look for other files. Do not ask for the project's README, its design
notes, or any example from this process. If the spec does not contain something
you need, write nothing and say what is missing.
"""

RETRY = """`verify_generated.py` rejected the agent.py you wrote:

{findings}

Regenerate the whole file. Do not patch around the findings -- a generated
module hand-edited to pass a lint is no longer traceable to its spec.
"""


def _sandbox(spec: Spec, directory: Path) -> None:
    """Lay out the skill's entire world. Three files, and the skill itself."""
    (directory / "spec.json").write_text(json.dumps(spec.data, indent=2, sort_keys=True))
    (directory / "RUNTIME_API.md").write_text(surface())
    shutil.copy(SKILL_DIR / "TEMPLATES.md", directory / "TEMPLATES.md")

    # Claude Code discovers skills under .claude/skills/.
    skills = directory / ".claude" / "skills" / "spec-to-agent"
    skills.mkdir(parents=True, exist_ok=True)
    shutil.copy(SKILL_DIR / "SKILL.md", skills / "SKILL.md")
    shutil.copy(SKILL_DIR / "TEMPLATES.md", skills / "TEMPLATES.md")


def _invoke(prompt: str, directory: Path) -> str:
    result = subprocess.run(
        [
            "claude",
            "-p",
            prompt,
            "--permission-mode",
            "acceptEdits",
            "--allowed-tools",
            "Read,Write,Edit,Skill,Glob",
        ],
        cwd=directory,
        capture_output=True,
        text=True,
        timeout=900,
    )
    if result.returncode != 0:
        raise SystemExit(f"claude exited {result.returncode}:\n{result.stderr[-2000:]}")
    return result.stdout


def gen(process_id: str, expect_hash: str | None = None) -> int:
    spec = Spec.load(spec_path(process_id))
    if expect_hash and expect_hash.split(":")[-1] not in spec.spec_hash:
        raise SystemExit(
            f"{process_id} on disk is {spec.spec_hash}, not {expect_hash}. "
            f"Run `cli pull --spec {expect_hash}` first."
        )

    if spec.fail_handlers:
        print(
            f"  note: {len(spec.fail_handlers)} fail handler(s) in the spec are not emitted. "
            "The fail edge is out of scope for this build."
        )

    with tempfile.TemporaryDirectory(prefix=f"gen-{process_id}-") as tmp:
        directory = Path(tmp)
        _sandbox(spec, directory)
        print(f"  sandbox: {directory}")
        print(f"  context: spec.json, RUNTIME_API.md, TEMPLATES.md — and nothing else")

        produced = directory / "agent.py"
        prompt = PROMPT
        for attempt in range(1, MAX_ATTEMPTS + 1):
            print(f"  invoking spec-to-agent (attempt {attempt}/{MAX_ATTEMPTS})…", flush=True)
            output = _invoke(prompt, directory)

            if not produced.exists():
                print("  the skill wrote no agent.py. It said:\n")
                print("    " + "\n    ".join(output.strip().splitlines()[-20:]))
                return 1

            findings = verify(produced, spec)
            if not findings:
                print("  verify_generated: clean")
                break
            print(f"  verify_generated: {len(findings)} finding(s)")
            for f in findings:
                print(f"    - {f}")
            if attempt == MAX_ATTEMPTS:
                print("\n  giving up after 3 attempts. The agent was not written.")
                return 1
            prompt = RETRY.format(findings="\n".join(f"  - {f}" for f in findings))

        out_dir = agent_dir(process_id)
        out_dir.mkdir(parents=True, exist_ok=True)
        (out_dir / "__init__.py").write_text('from .agent import run\n\n__all__ = ["run"]\n')
        shutil.copy(produced, out_dir / "agent.py")
        print(f"  emitted {out_dir / 'agent.py'}")

    _report_reference_diff(process_id)
    return 0


def _report_reference_diff(process_id: str) -> None:
    """Point at the reference agent when one exists.

    Keeping this in front of a human matters more now, not less: with a model
    writing the file, the reference is the only thing that says whether an
    unfamiliar shape is a better idea or a regression. It caught one real bug
    already -- a template chosen on whether a parent existed rather than on
    whether the parent had fields.
    """
    reference = agent_dir(process_id).parent / "reference" / "agent.py"
    if not reference.exists():
        return
    print(
        f"\n  a hand-written reference exists. Diff it:\n"
        f"    diff processes/{process_id}/reference/agent.py "
        f"processes/{process_id}/agent/agent.py"
    )
