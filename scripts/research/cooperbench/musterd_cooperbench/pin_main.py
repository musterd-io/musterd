"""Pin the container's local `main` to the task base, in every arm alike (lane 01M5E8CHBT).

CooperBench's task images check the repository out at the task base as a detached HEAD and keep the
upstream repository's `main` branch beside it, at a later commit. `build_git_setup_command` pushes
the base to the shared remote as `team/main` and tells the agent so, but the stale local `main`
stays. In the first pilot (finding 015) two of twenty agents wrote their submission as
`git diff main -- <file>`: a diff against the wrong commit, which failed to apply on the base, so
the pair was lost to a branch name rather than to coordination.

The fix is one more step in the same setup command: `git branch -f main HEAD`, so `main` and
`team/main` name the base. It is applied by replacing the symbol CooperBench's own adapters import,
so the plain coop arm, the team arm and the musterd arm run the identical setup — the only honest
shape for a harness fix that must not favour one arm. Reported upstream as the image/harness
hazard it is; this stays until a pinned CooperBench carries the fix.
"""

from __future__ import annotations

import importlib

PIN_MAIN = "git branch -f main HEAD"

_original = None


def pinned_git_setup_command(*, agent_id: str, server_url: str) -> str:
    """CooperBench's setup command with the local `main` pinned to the base."""
    assert _original is not None, "install_pin_main() first"
    cmd = _original(agent_id=agent_id, server_url=server_url)
    # The original ends with `… || true`; the pin goes before the push of HEAD to the remote's
    # main so a failure to pin is a failure to set up, not a silent skip.
    marker = "git push team HEAD:refs/heads/main"
    if marker in cmd:
        return cmd.replace(marker, f"{PIN_MAIN} && {marker}", 1)
    return f"{cmd} && {PIN_MAIN}"


def install_pin_main() -> None:
    """Replace `build_git_setup_command` wherever CooperBench's adapters bound it. Idempotent."""
    global _original
    coop = importlib.import_module("cooperbench.agents._coop")
    if _original is None:
        _original = coop.build_git_setup_command
    if coop.build_git_setup_command is not pinned_git_setup_command:
        coop.build_git_setup_command = pinned_git_setup_command
    for name in ("cooperbench.agents.claude_code.adapter", "musterd_cooperbench.adapter"):
        try:
            mod = importlib.import_module(name)
        except ImportError:
            continue
        if getattr(mod, "build_git_setup_command", None) is not None:
            mod.build_git_setup_command = pinned_git_setup_command
