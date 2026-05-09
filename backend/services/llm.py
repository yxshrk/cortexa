"""Shared LLM client + tool-use helper for synthesize/categorize/draft.

OpenAI Chat Completions with function-calling forces structured JSON output.
Each caller defines a single function whose ``parameters`` is the JSON schema
we want back; we look for the first ``tool_calls`` entry in the response and
return its ``function.arguments`` parsed as JSON.

Public surface (kept stable across LLM swaps):

    call_with_tool(system, user, tool_name, tool_description, tool_schema)
        -> dict

Synthesizer / categorizer / action_drafter import this and never touch the
underlying SDK directly, so swapping providers is a one-file change.
"""
from __future__ import annotations

import json
import logging
from typing import Any

from openai import AsyncOpenAI

from settings import get_settings

log = logging.getLogger(__name__)

# gpt-4.1 supports rich tool/function-calling and is the right tier for
# synthesis-class work. Override via env if a cheaper/faster model fits.
DEFAULT_MODEL = "gpt-4.1"
DEFAULT_MAX_TOKENS = 4096

_client: AsyncOpenAI | None = None


def get_client() -> AsyncOpenAI:
    global _client
    if _client is None:
        s = get_settings()
        if not s.openai_key:
            raise RuntimeError("OPENAI_KEY not set; cannot call LLM.")
        _client = AsyncOpenAI(api_key=s.openai_key)
    return _client


async def call_with_tool(
    *,
    system: str,
    user: str,
    tool_name: str,
    tool_description: str,
    tool_schema: dict[str, Any],
    max_tokens: int = DEFAULT_MAX_TOKENS,
) -> dict[str, Any]:
    """Run an OpenAI chat completion with a single forced function call.

    Returns the function's parsed arguments as a dict.
    """
    client = get_client()
    resp = await client.chat.completions.create(
        model=DEFAULT_MODEL,
        max_tokens=max_tokens,
        messages=[
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
        tools=[
            {
                "type": "function",
                "function": {
                    "name": tool_name,
                    "description": tool_description,
                    "parameters": tool_schema,
                },
            }
        ],
        tool_choice={"type": "function", "function": {"name": tool_name}},
    )

    choice = resp.choices[0]
    tool_calls = getattr(choice.message, "tool_calls", None) or []
    for tc in tool_calls:
        fn = getattr(tc, "function", None)
        if fn is None:
            continue
        if getattr(fn, "name", None) != tool_name:
            continue
        args = getattr(fn, "arguments", None)
        if isinstance(args, dict):
            return args
        if isinstance(args, str):
            try:
                return json.loads(args)
            except json.JSONDecodeError as e:
                log.warning("tool_call arguments not valid JSON: %s", e)
                continue

    raise RuntimeError(
        f"OpenAI did not produce a tool_call for {tool_name!r}; "
        f"finish_reason={choice.finish_reason!r}"
    )
