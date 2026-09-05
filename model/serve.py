"""
Serves the fine-tuned model, as an API and as a web page.

    python model/serve.py            # both, on http://127.0.0.1:8008
    python model/serve.py --port 9000

Two things live here:

  /                        a chat page anyone can use in a browser. Nothing to
                           install. Point a tunnel at this and teammates just
                           open a link.
  /v1/chat/completions     the OpenAI-compatible API the extension talks to.

Both can run either the fine-tuned model or the untrained base, so the effect
of the training can be seen side by side. The adapter is toggled rather than
loaded twice, so both come from an identical setup and the training is the only
difference.

Model names:
  elenchus        the team's fine-tuned model
  elenchus-base   the same base model with the training switched off
"""

import argparse
import json
import sys
import time
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Lock

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

ADAPTER = HERE / "out" / "adapter"
BASE_MODEL = "Qwen/Qwen2.5-Coder-0.5B-Instruct"
PORT = 8008

TRAINED_NAME = "elenchus"
BASE_NAME = "elenchus-base"

STATE = {"model": None, "tokenizer": None, "device": "cpu", "has_adapter": False}

# One GPU, many possible visitors. Generation is serialised so concurrent
# requests queue instead of colliding.
GPU_LOCK = Lock()


def load(force_base=False):
    import torch
    from transformers import AutoModelForCausalLM, AutoTokenizer

    device = "cuda" if torch.cuda.is_available() else "cpu"
    if device == "cuda":
        try:
            (torch.ones(8, 8, device="cuda") @ torch.ones(8, 8, device="cuda")).sum().item()
        except Exception:
            device = "cpu"

    tokenizer = AutoTokenizer.from_pretrained(BASE_MODEL)
    try:
        model = AutoModelForCausalLM.from_pretrained(BASE_MODEL, dtype=torch.float32)
    except TypeError:  # transformers 4.x spelling
        model = AutoModelForCausalLM.from_pretrained(BASE_MODEL, torch_dtype=torch.float32)

    has_adapter = False
    if not force_base:
        if ADAPTER.exists():
            from peft import PeftModel
            # Deliberately NOT merged: keeping the adapter separate is what lets
            # a request ask for the untrained base on the same loaded weights.
            model = PeftModel.from_pretrained(model, str(ADAPTER))
            has_adapter = True
        else:
            print(f"No adapter at {ADAPTER}; serving the base model only.")

    model.to(device).eval()
    model.config.use_cache = True
    STATE.update(model=model, tokenizer=tokenizer, device=device, has_adapter=has_adapter)
    print(f"loaded on {device} | adapter: {'yes' if has_adapter else 'no'}")


def chat_ids(tok, messages):
    """Plain list of ids; transformers 4.x returns a list, 5.x a dict-like."""
    out = tok.apply_chat_template(messages, add_generation_prompt=True, tokenize=True)
    if hasattr(out, "keys") or isinstance(out, dict):
        out = out["input_ids"]
    if len(out) and isinstance(out[0], (list, tuple)):
        out = out[0]
    return [int(t) for t in out]


def generate(messages, temperature=0.6, max_tokens=200, use_adapter=True):
    import torch
    tok, model = STATE["tokenizer"], STATE["model"]
    ids = torch.tensor([chat_ids(tok, messages)]).to(STATE["device"])
    kwargs = dict(
        max_new_tokens=max_tokens,
        do_sample=temperature > 0,
        temperature=max(temperature, 1e-3),
        top_p=0.9,
        repetition_penalty=1.05,
        pad_token_id=tok.pad_token_id,
    )
    with GPU_LOCK, torch.inference_mode():
        if use_adapter or not STATE["has_adapter"]:
            out = model.generate(ids, **kwargs)
        else:
            with model.disable_adapter():
                out = model.generate(ids, **kwargs)
    return tok.decode(out[0][ids.shape[1]:], skip_special_tokens=True).strip()


SYSTEM_PROMPT = (HERE / "compact_prompt.txt").read_text(encoding="utf-8").strip()


def number_lines(code):
    lines = code.replace("\r\n", "\n").split("\n")
    width = len(str(len(lines)))
    return "\n".join(f"{str(i + 1).rjust(width)} | {ln}" for i, ln in enumerate(lines))


def build_first_turn(code, question):
    """Matches prompt.js buildFirstTurn, so the page and the extension agree."""
    parts = ["Here is the code I selected:\n\n" + number_lines(code.rstrip())]
    if question and question.strip():
        parts.append("My question: " + question.strip())
    else:
        parts.append("I have not added a question. Find what is wrong with this code.")
    parts.append(
        "I have not told you whether it runs, or what error it gives. Do not assume "
        "it runs cleanly — if you can see that it would fail, treat that as the problem."
    )
    return "\n\n".join(parts)


class Handler(BaseHTTPRequestHandler):
    server_version = "Elenchus/1.0"

    def _send(self, code, body, ctype):
        if isinstance(body, str):
            body = body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def _json(self, code, obj):
        self._send(code, json.dumps(obj), "application/json; charset=utf-8")

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
        self.send_header("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
        self.end_headers()

    def do_GET(self):
        path = self.path.split("?")[0]
        if path in ("/", "/index.html"):
            page = (HERE / "web" / "index.html").read_text(encoding="utf-8")
            return self._send(200, page, "text/html; charset=utf-8")
        if path.startswith("/v1/models"):
            ids = [TRAINED_NAME] if STATE["has_adapter"] else []
            ids.append(BASE_NAME)
            return self._json(200, {"data": [{"id": i, "object": "model"} for i in ids]})
        self._json(404, {"error": {"message": "not found"}})

    def do_POST(self):
        path = self.path.split("?")[0]
        try:
            length = int(self.headers.get("Content-Length", "0"))
            req = json.loads(self.rfile.read(length) or b"{}")
        except Exception as e:
            return self._json(400, {"error": {"message": f"bad request: {e}"}})

        try:
            if path.startswith("/v1/chat/completions"):
                return self._api(req)
            if path.startswith("/ask"):
                return self._ask(req)
            self._json(404, {"error": {"message": "not found"}})
        except Exception as e:
            traceback.print_exc()
            self._json(500, {"error": {"message": f"{type(e).__name__}: {e}"}})

    def _api(self, req):
        """The OpenAI-compatible endpoint the VS Code extension uses."""
        messages = req.get("messages") or []
        wants_base = str(req.get("model", TRAINED_NAME)) == BASE_NAME
        t0 = time.time()
        text = generate(
            messages,
            temperature=float(req.get("temperature", 0.6)),
            max_tokens=min(int(req.get("max_tokens", 200)), 400),
            use_adapter=not wants_base,
        )
        print(f"[api {time.time() - t0:5.1f}s] {text[:80]}")
        self._json(200, {
            "id": "local", "object": "chat.completion",
            "model": BASE_NAME if wants_base else TRAINED_NAME,
            "choices": [{"index": 0, "message": {"role": "assistant", "content": text},
                         "finish_reason": "stop"}],
        })

    def _ask(self, req):
        """The browser page. Builds the first turn the way the extension does."""
        from guardrail_py import inspect

        history = req.get("history") or []
        code = (req.get("code") or "").strip()
        question = (req.get("question") or "").strip()
        use_adapter = bool(req.get("trained", True))

        if history:
            messages = [{"role": "system", "content": SYSTEM_PROMPT}] + history
            messages.append({"role": "user", "content": question})
        else:
            if not code:
                return self._json(400, {"error": {"message": "Paste some code first."}})
            messages = [
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": build_first_turn(code, question)},
            ]

        t0 = time.time()
        text = generate(messages, max_tokens=220, use_adapter=use_adapter)
        took = time.time() - t0
        reasons = inspect(text)
        print(f"[web {took:5.1f}s {'trained' if use_adapter else 'base   '}] "
              f"{'BLOCKED ' if reasons else ''}{text[:70]}")

        self._json(200, {
            "reply": text,
            "blocked": bool(reasons),
            "reasons": reasons,
            "seconds": round(took, 1),
            "model": TRAINED_NAME if use_adapter else BASE_NAME,
            "turn": messages[-1]["content"],
        })

    def log_message(self, *_):
        pass  # the replies themselves are the useful log


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", action="store_true", help="serve only the untrained base model")
    ap.add_argument("--port", type=int, default=PORT)
    ap.add_argument("--host", default="127.0.0.1",
                    help="use 0.0.0.0 to accept connections from your local network")
    args = ap.parse_args()

    load(force_base=args.base)
    print(f"\n  web page : http://{args.host}:{args.port}/")
    print(f"  API      : http://{args.host}:{args.port}/v1")
    print(f"  extension: provider = local, model = {TRAINED_NAME}")
    print("\n  Ctrl+C to stop\n")
    try:
        ThreadingHTTPServer((args.host, args.port), Handler).serve_forever()
    except KeyboardInterrupt:
        print("\nstopped")
