"""The local `main` pin applies to every arm's git setup, theirs and ours (lane 01M5E8CHBT)."""

from __future__ import annotations

import cooperbench.agents._coop as coop
import cooperbench.agents.claude_code.adapter as cc

from musterd_cooperbench import adapter as ours
from musterd_cooperbench.pin_main import PIN_MAIN, install_pin_main, pinned_git_setup_command


def test_every_arm_builds_its_git_setup_through_the_pin():
    install_pin_main()
    assert coop.build_git_setup_command is pinned_git_setup_command
    assert cc.build_git_setup_command is pinned_git_setup_command
    assert ours.build_git_setup_command is pinned_git_setup_command


def test_the_pin_sits_before_the_push_of_the_base_to_the_remote():
    install_pin_main()
    cmd = pinned_git_setup_command(agent_id="agent1", server_url="http://git:9418/repo")
    assert PIN_MAIN in cmd
    assert cmd.index(PIN_MAIN) < cmd.index("git push team HEAD:refs/heads/main")
    # Everything CooperBench's own command does is still there, unchanged.
    assert "git remote add team" in cmd and "git checkout -b agent1" in cmd
    assert "git push -u team agent1 --force" in cmd


def test_install_is_idempotent():
    install_pin_main()
    install_pin_main()
    cmd = pinned_git_setup_command(agent_id="a", server_url="u")
    assert cmd.count(PIN_MAIN) == 1
