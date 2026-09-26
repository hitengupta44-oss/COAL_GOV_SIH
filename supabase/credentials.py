"""
Shared credential loader for the seed/maintenance scripts.

WHY THIS EXISTS: these scripts run on your own machine and need the
Supabase service-role key. Rather than requiring a .env file on disk, this
prompts for anything that isn't already set as an environment variable.

Order of preference:
  1. An environment variable, if you've exported one
  2. An interactive prompt

The service-role key is read with getpass, so it is not echoed to your
terminal and does not end up in your shell history. Nothing is written to
disk by this module.
"""

import os
from getpass import getpass


def _ask(name, prompt, secret=False):
    value = os.environ.get(name)
    if value:
        return value
    try:
        value = getpass(prompt) if secret else input(prompt)
    except (EOFError, KeyboardInterrupt):
        raise SystemExit("\nCancelled.")
    value = value.strip()
    if not value:
        raise SystemExit(f"{name} is required.")
    return value


def get_supabase_credentials():
    """Returns (url, service_role_key), prompting for whatever is missing."""
    url = _ask(
        "SUPABASE_URL",
        "Supabase Project URL (Settings > API > Project URL): ",
    )
    key = _ask(
        "SUPABASE_SERVICE_ROLE_KEY",
        "Supabase service_role key (Settings > API, input hidden): ",
        secret=True,
    )
    if not url.startswith("http"):
        raise SystemExit(f"That doesn't look like a URL: {url}")
    return url.rstrip("/"), key


def get_groq_key(required=False):
    """Returns the Groq API key, or None if not needed and not provided."""
    key = os.environ.get("GROQ_API_KEY")
    if key:
        return key
    if not required:
        return None
    return _ask("GROQ_API_KEY", "Groq API key (input hidden): ", secret=True)
