"""prompt-polish backend — server half of the Tab-key prompt polishing.

Runs inside the Hermes gateway/serve process and is reached by the desktop
plugin through ctx.rest('/…') → /api/plugins/prompt-polish.

Engine chain for POST /polish:
  1) Hermes auxiliary model (task=prompt_polish, user's configured provider,
     no extra API bill) — primary path, rewrites the draft into a strong prompt.
  2) prompts.chat MCP improve_prompt — only when PROMPTS_API_KEY is configured
     ($HERMES_HOME/.env); failures degrade silently.
  3) prompts.chat community search (keyless) — last-resort fallback; the UI
     then offers one-click adoption of a retrieved prompt via GET /prompt.

The renderer never contacts external APIs directly (CORS); this bridge keeps
credentials server-side.
"""
import json
import logging
import os
import re

import httpx
from fastapi import APIRouter, Body, Query

logger = logging.getLogger(__name__)
router = APIRouter()

MCP_URL = "https://prompts.chat/api/mcp"
AUX_TASK = "prompt_polish"

_POLISH_SYSTEM = """你是一名提示词工程专家。用户在聊天输入框里写了一段草稿，按 Tab 请求润色。
把草稿重写成一个高质量、可直接执行的任务提示词，硬性要求：
- 输出语言必须与草稿语言完全一致：中文草稿→中文输出，英文草稿→英文输出
- 保留用户的原始意图和所有具体名词（如库名、文件名）
- 补全隐含的目标、约束、交付物与验收标准；结构化但不啰嗦
- 只输出润色后的提示词本身，不要任何前言、解释或引号包裹
- 草稿若已经完整清晰，做轻度打磨即可，不要注水"""
_KEY_LINE = re.compile(r"^\s*(?:export\s+)?PROMPTS_API_KEY\s*=\s*(.+?)\s*$")


def _hermes_home() -> str:
    return os.environ.get("HERMES_HOME") or os.path.join(os.path.expanduser("~"), ".hermes")


def _api_key() -> str | None:
    key = os.environ.get("PROMPTS_API_KEY")
    if key:
        return key.strip()
    try:
        with open(os.path.join(_hermes_home(), ".env"), encoding="utf-8") as fh:
            for line in fh:
                m = _KEY_LINE.match(line)
                if m:
                    return m.group(1).strip('"').strip("'") or None
    except OSError:
        pass
    return None


def _parse_sse(text: str) -> dict:
    for line in text.splitlines():
        if line.startswith("data:"):
            return json.loads(line[5:].strip())
    raise RuntimeError("no MCP message in response")


def _mcp_tool(tool: str, arguments: dict, timeout: float = 75.0) -> str:
    headers = {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
    }
    key = _api_key()
    if key:
        headers["PROMPTS_API_KEY"] = key
    payload = {
        "jsonrpc": "2.0",
        "id": 1,
        "method": "tools/call",
        "params": {"name": tool, "arguments": arguments},
    }
    resp = httpx.post(MCP_URL, json=payload, headers=headers, timeout=timeout, follow_redirects=True)
    if resp.status_code >= 400:
        raise RuntimeError(f"HTTP {resp.status_code}")
    msg = _parse_sse(resp.text)
    if msg.get("error"):
        raise RuntimeError(str(msg["error"]))
    result = msg.get("result") or {}
    text = "\n".join(
        c.get("text", "") for c in result.get("content", []) if c.get("type") == "text"
    )
    if result.get("isError"):
        raise RuntimeError(text or "tool error")
    return text


def _first_string_field(raw: str, keys: tuple[str, ...]) -> str | None:
    try:
        obj = json.loads(raw)
    except (ValueError, TypeError):
        return None
    if not isinstance(obj, dict):
        return None
    for k in keys:
        v = obj.get(k)
        if isinstance(v, str) and v.strip():
            return v
    return None


def _aux_polish(draft: str) -> str:
    """Polish via the Hermes auxiliary model (user's configured provider). Raises on failure."""
    from agent.auxiliary_client import call_llm, extract_content_or_reasoning

    response = call_llm(
        task=AUX_TASK,
        messages=[
            {"role": "system", "content": _POLISH_SYSTEM},
            {"role": "user", "content": draft},
        ],
        temperature=0.4,
        max_tokens=2048,
        timeout=60,
        route_info={},
    )
    text = (extract_content_or_reasoning(response) or "").strip()
    if not text:
        raise RuntimeError("auxiliary model returned empty")
    return text


@router.get("/status")
async def status():
    return {"key_configured": bool(_api_key())}


@router.post("/polish")
async def polish(body: dict = Body(...)):
    draft = str(body.get("prompt") or "").strip()
    if not draft:
        return {"mode": "error", "error": "draft is empty"}

    # 1) Primary: local auxiliary model (no extra API bill)
    try:
        return {"mode": "improve", "text": _aux_polish(draft)}
    except Exception as exc:  # noqa: BLE001
        logger.warning("prompt-polish: auxiliary polish failed: %s", exc)

    # 2) Optional: official improve_prompt via prompts.chat MCP (needs PROMPTS_API_KEY)
    if _api_key():
        try:
            out = _mcp_tool(
                "improve_prompt",
                {
                    "prompt": draft,
                    "outputType": str(body.get("outputType") or "text"),
                    "outputFormat": "text",
                },
            )
            polished = _first_string_field(
                out, ("improvedPrompt", "improved_prompt", "prompt", "content", "result", "text")
            ) or out.strip()
            if polished:
                return {"mode": "improve", "text": polished}
        except Exception as exc:  # noqa: BLE001
            logger.info("prompt-polish: improve_prompt unavailable: %s", exc)

    # 3) Last resort: community search (low hit rate, keyless)
    try:
        found = _mcp_tool("search_prompts", {"query": draft[:120], "limit": 5})
        items = []
        try:
            data = json.loads(found)
        except (ValueError, TypeError):
            data = None
        for p in (data or {}).get("prompts", []) if isinstance(data, dict) else []:
            items.append(
                {
                    "id": p.get("id") or p.get("slug"),
                    "title": p.get("title") or "(untitled)",
                    "preview": (p.get("contentPreview") or "").strip(),
                    "tags": p.get("tags") or [],
                }
            )
        return {"mode": "search", "items": items}
    except Exception as exc:  # noqa: BLE001
        return {"mode": "error", "error": f"polish and search both failed ({exc})"}


@router.get("/prompt")
async def fetch_prompt(id: str = Query(...)):
    try:
        raw = _mcp_tool("get_prompt", {"id": id})
        content = _first_string_field(raw, ("content", "prompt", "text", "body")) or raw
        return {"ok": True, "content": content}
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": str(exc)}
