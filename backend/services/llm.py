"""Shared LLM client + tool-use helper for synthesize/categorize/draft.

Uses OpenAI Chat Completions with function-calling to force structured JSON
output. Default model is ``gpt-5`` with ``reasoning_effort="low"``; if the
model isn't available on the caller's API key (404) we transparently fall
back to ``gpt-4.1``.

Public surface (kept stable across LLM swaps):

    call_with_tool(
        system, user, tool_name, tool_description, tool_schema,
        emit=None,                     # optional async callback(event:dict)
        emit_phase="synthesize",       # tag attached to emitted events
    ) -> dict

The ``emit`` callback is awaited with structured stage events so callers can
persist them as a progress trace. We emit:

  * ``{kind: "info",      phase, message}`` — at request start (model, mode)
  * ``{kind: "reasoning", phase, message}`` — when the model surfaces a
    reasoning summary block (gpt-5 / o-series). Best-effort; not all
    deployments emit one.
  * ``{kind: "info",      phase, message, extra: { input_tokens, output_tokens, took_ms }}``
    — at request end.

Synthesizer / categorizer / action_drafter import this and never touch the
underlying SDK directly, so swapping providers is a one-file change.
"""
from __future__ import annotations

import asyncio
import json
import logging
import time
from typing import Any, Awaitable, Callable

from openai import AsyncOpenAI, NotFoundError

from settings import get_settings

log = logging.getLogger(__name__)

PRIMARY_MODEL = "gpt-5"
FALLBACK_MODEL = "gpt-4.1"
DEFAULT_REASONING_EFFORT = "low"
DEFAULT_MAX_TOKENS = 4096

EmitFn = Callable[[dict[str, Any]], Awaitable[None]]

_client: AsyncOpenAI | None = None
# After the first successful call we remember which model worked so we don't
# pay the 404 round-trip on every call. Reset on process restart.
_resolved_model: str | None = None


def get_client() -> AsyncOpenAI:
    global _client
    if _client is None:
        s = get_settings()
        if not s.openai_key:
            raise RuntimeError("OPENAI_KEY not set; cannot call LLM.")
        _client = AsyncOpenAI(api_key=s.openai_key)
    return _client


async def _maybe_emit(emit: EmitFn | None, event: dict[str, Any]) -> None:
    if emit is None:
        return
    try:
        await emit(event)
    except Exception as e:  # noqa: BLE001
        # Never let a broken trace sink the actual LLM call.
        log.warning("emit() raised; swallowing: %s", e)


def _is_reasoning_capable(model: str) -> bool:
    # gpt-5 family + o-series support reasoning_effort. gpt-4.1 does not.
    m = model.lower()
    return m.startswith("gpt-5") or m.startswith("o1") or m.startswith("o3") or m.startswith("o4")


def _build_kwargs(
    *,
    model: str,
    system: str,
    user: str,
    tool_name: str,
    tool_description: str,
    tool_schema: dict[str, Any],
    max_tokens: int,
) -> dict[str, Any]:
    kwargs: dict[str, Any] = {
        "model": model,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
        "tools": [
            {
                "type": "function",
                "function": {
                    "name": tool_name,
                    "description": tool_description,
                    "parameters": tool_schema,
                },
            }
        ],
        "tool_choice": {"type": "function", "function": {"name": tool_name}},
    }
    # gpt-5 changed the parameter name + only allows reasoning models to use it.
    if _is_reasoning_capable(model):
        kwargs["reasoning_effort"] = DEFAULT_REASONING_EFFORT
        kwargs["max_completion_tokens"] = max_tokens
    else:
        kwargs["max_tokens"] = max_tokens
    return kwargs


async def call_with_tool(
    *,
    system: str,
    user: str,
    tool_name: str,
    tool_description: str,
    tool_schema: dict[str, Any],
    max_tokens: int = DEFAULT_MAX_TOKENS,
    emit: EmitFn | None = None,
    emit_phase: str = "llm",
) -> dict[str, Any]:
    """Run an OpenAI chat completion with a single forced function call.

    Returns the function's parsed arguments as a dict.
    """
    global _resolved_model
    client = get_client()

    candidates = [_resolved_model] if _resolved_model else [PRIMARY_MODEL, FALLBACK_MODEL]
    last_err: Exception | None = None

    for model in candidates:
        if model is None:
            continue
        kwargs = _build_kwargs(
            model=model,
            system=system,
            user=user,
            tool_name=tool_name,
            tool_description=tool_description,
            tool_schema=tool_schema,
            max_tokens=max_tokens,
        )
        await _maybe_emit(
            emit,
            {
                "phase": emit_phase,
                "kind": "info",
                "message": f"calling {model}"
                + (f" (reasoning={DEFAULT_REASONING_EFFORT})" if _is_reasoning_capable(model) else ""),
            },
        )
        t0 = time.monotonic()
        try:
            resp = await client.chat.completions.create(**kwargs)
        except NotFoundError as e:
            # Model not available on this key — fall through to next candidate.
            log.info("model %s not available; falling back: %s", model, e)
            last_err = e
            continue
        except Exception as e:
            last_err = e
            # Some accounts return 400 instead of 404 for model gating. Retry once.
            text = repr(e).lower()
            if "model" in text and "does not" in text:
                log.info("model %s rejected; falling back: %s", model, e)
                continue
            raise

        took_ms = int((time.monotonic() - t0) * 1000)
        _resolved_model = model

        # Best-effort reasoning summary. Different SDK versions expose this in
        # different fields; we probe a few. None of these throw if missing.
        await _emit_reasoning_if_any(emit, emit_phase, resp)

        result = _extract_tool_call_args(resp, tool_name)
        usage = getattr(resp, "usage", None)
        await _maybe_emit(
            emit,
            {
                "phase": emit_phase,
                "kind": "info",
                "message": f"{model} responded in {took_ms} ms",
                "extra": {
                    "model": model,
                    "took_ms": took_ms,
                    "input_tokens": getattr(usage, "prompt_tokens", None),
                    "output_tokens": getattr(usage, "completion_tokens", None),
                },
            },
        )
        return result

    # All candidates failed.
    raise RuntimeError(
        f"All LLM model candidates failed ({candidates!r}); last error: {last_err!r}"
    )


def _extract_tool_call_args(resp: Any, tool_name: str) -> dict[str, Any]:
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
        f"Model did not produce a tool_call for {tool_name!r}; "
        f"finish_reason={getattr(choice, 'finish_reason', None)!r}"
    )


async def _emit_reasoning_if_any(
    emit: EmitFn | None, emit_phase: str, resp: Any
) -> None:
    """Look for a reasoning summary on the response and emit it.

    The chat-completions surface for reasoning summaries is still in flux
    across SDK versions — we probe several known shapes, accept the first one
    that has text, and never raise.
    """
    if emit is None:
        return
    try:
        choice = resp.choices[0]
        msg = choice.message
        # Newer SDKs may attach `reasoning` (object with content list) or
        # `reasoning_content` (string) to the message.
        candidates: list[str] = []
        rc = getattr(msg, "reasoning_content", None)
        if isinstance(rc, str) and rc.strip():
            candidates.append(rc.strip())
        reasoning = getattr(msg, "reasoning", None)
        if reasoning is not None:
            content = getattr(reasoning, "content", None) or reasoning
            if isinstance(content, list):
                for blk in content:
                    txt = getattr(blk, "text", None) or (blk.get("text") if isinstance(blk, dict) else None)
                    if isinstance(txt, str) and txt.strip():
                        candidates.append(txt.strip())
            elif isinstance(content, str) and content.strip():
                candidates.append(content.strip())
        for txt in candidates:
            # Cap the per-event size so a chatty reasoner can't blow up the
            # progress jsonb.
            await _maybe_emit(
                emit,
                {
                    "phase": emit_phase,
                    "kind": "reasoning",
                    "message": txt[:600],
                },
            )
    except Exception as e:  # noqa: BLE001
        log.debug("reasoning probe failed: %s", e)


# Convenience: synchronous emit wrapper for callers that already have a sync
# context. Schedules the awaitable on a fresh event loop only if there isn't
# one running.
def make_sync_emit(emit: EmitFn) -> Callable[[dict[str, Any]], None]:
    def _sync_emit(event: dict[str, Any]) -> None:
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            asyncio.run(emit(event))
            return
        loop.create_task(emit(event))
    return _sync_emit
