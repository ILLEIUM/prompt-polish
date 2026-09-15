"""prompt-polish agent half — presence only.

The desktop UI (Tab polishing) talks to dashboard/plugin_api.py directly; this
module exists because the plugin loader requires a package __init__.py in the
plugin folder, and intentionally registers nothing.
"""


def register(ctx):  # noqa: ARG001 — no agent-side tools/hooks to register
    return None
