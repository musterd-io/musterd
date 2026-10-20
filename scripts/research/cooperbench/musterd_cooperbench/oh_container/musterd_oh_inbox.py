"""musterd's mid-run interrupt line in the OpenHands loop, in the slot the plain arm's Redis inbox uses.

CooperBench's OpenHands fork checks a Redis inbox before every agent step and injects each message as
a user message (``LocalConversation._check_inbox_messages``). That is how the plain coop arm hears
its partner mid-run. OpenHands' PostToolUse hooks can't add text to the conversation, so musterd's
interrupt hook (what a Claude Code seat runs after every tool call) has no slot of its own here. This
module gives it the plain arm's: after the Redis check, it runs ``musterd inbox --interrupt-check``
and injects the daemon's line, if there is one, the same way.

Loaded into the agent-server's Python by ``musterd-oh-inbox.pth`` and active only when
``MUSTERD_OH_INTERRUPT=1`` (the musterd arm's container). It patches the module after it loads,
so importing it never imports OpenHands early.
"""

from __future__ import annotations

import importlib.abc
import importlib.machinery
import os
import subprocess
import sys

TARGET = "openhands.sdk.conversation.impl.local_conversation"
REPO = "/workspace/repo"


def interrupt_line(cwd: str = REPO, timeout: float = 10.0) -> str | None:
    """The daemon's one-line interrupt notice, or None. Read-only: it never moves the read cursor."""
    try:
        proc = subprocess.run(
            ["musterd", "inbox", "--interrupt-check"],
            cwd=cwd,
            capture_output=True,
            text=True,
            timeout=timeout,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    line = (proc.stdout or "").strip()
    if not line.startswith("⚡"):
        # e.g. the "deaf" line at step 0, before the plugin's MCP server has joined and holds the
        # lease. The Claude Code arm's adapter joins before the first prompt and never sees it, so it
        # stays out of the conversation and goes to the agent-server's log.
        if line:
            print(f"musterd interrupt check: {line}", file=sys.stderr)
        return None
    return line


def patch(module) -> None:
    original = module.LocalConversation._check_inbox_messages

    def _check_inbox_messages(self) -> None:
        original(self)
        line = interrupt_line()
        if not line:
            return
        self._on_event(
            module.MessageEvent(
                source="user",
                llm_message=module.Message(role="user", content=[module.TextContent(text=line)]),
            )
        )

    module.LocalConversation._check_inbox_messages = _check_inbox_messages


class _Loader(importlib.abc.Loader):
    def __init__(self, inner):
        self.inner = inner

    def create_module(self, spec):
        return self.inner.create_module(spec)

    def exec_module(self, module):
        self.inner.exec_module(module)
        patch(module)


class _Finder(importlib.abc.MetaPathFinder):
    def find_spec(self, name, path, target=None):
        if name != TARGET:
            return None
        spec = importlib.machinery.PathFinder.find_spec(name, path)
        if spec is not None and spec.loader is not None:
            spec.loader = _Loader(spec.loader)
        return spec


def install() -> None:
    if os.environ.get("MUSTERD_OH_INTERRUPT") == "1" and not any(isinstance(f, _Finder) for f in sys.meta_path):
        sys.meta_path.insert(0, _Finder())


install()
