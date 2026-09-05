"""
Serves the fine-tuned model, as an API and as a web page.

    python model/serve.py                                     # fine-tuned + untrained base
    python model/serve.py --helper Qwen/Qwen2.5-Coder-1.5B-Instruct
    python model/serve.py --port 9000

Two things live here:

  /                        a chat page anyone can use in a browser. Nothing to
                           install. Point a tunnel at this and teammates just
                           open a link.
  /v1/chat/completions     the OpenAI-compatible API the extension talks to.

Model names the API accepts:

  elenchus         the team's fine-tuned 0.5B model. Good at Hint mode; cannot
                   emit line markers, produce fixes, or explain concepts.
  elenchus-base    the same 0.5B with the training switched off, for a
                   before-and-after. Toggled, not loaded twice.
  elenchus-helper  an optional larger untrained model (--helper). The extension
                   routes Strong hint, Direct answer and concept questions here
                   when no Groq key is stored, because the small model cannot
                   do those. Its quality on those tasks has NOT been verified;
                   check /v1/models to see whether it is loaded.
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

TRAINED = "elenchus"
BASE = "elenchus-base"
HELPER = "elenchus-helper"

# Replies shorter than this are almost always "Does it run?" — a question with
# nothing in it. A small floor pushes the model past the two-word reflex. Kept
# low so genuine short turns ("Good work!") are not padded into nonsense.
MIN_NEW_TOKENS = 6
MAX_TOKENS_CAP = 700  # the extension asks for 700 in Direct mode; do not truncate below it

STATE = {"tokenizer": None, "model": None, "device": "cpu", "has_adapter": False,
         "helper": None, "helper_tok": None, "helper_name": None}

# One GPU, many possible visitors. Generation is serialised so concurrent
# requests queue instead of colliding.
GPU_LOCK = Lock()


def _from_pretrained(name, dtype):
    import torch
    from transformers import AutoModelForCausalLM
    try:
        return AutoModelForCausalLM.from_pretrained(name, dtype=dtype)
    except TypeError:  # transformers 4.x spelling
        return AutoModelForCausalLM.from_pretrained(name, torch_dtype=dtype)


def load(force_base=False, helper=None):
    import torch
    from transformers import AutoTokenizer

    device = "cuda" if torch.cuda.is_available() else "cpu"
    if device == "cuda":
        try:
            (torch.ones(8, 8, device="cuda") @ torch.ones(8, 8, device="cuda")).sum().item()
        except Exception:
            device = "cpu"

    tokenizer = AutoTokenizer.from_pretrained(BASE_MODEL)
    model = _from_pretrained(BASE_MODEL, torch.float32)

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
    STATE.update(tokenizer=tokenizer, model=model, device=device, has_adapter=has_adapter)
    print(f"loaded {BASE_MODEL} on {device} | adapter: {'yes' if has_adapter else 'no'}")

    if helper:
        # Half precision on a GPU halves the memory; on CPU stay in float32,
        # where half precision is slow and sometimes unsupported.
        dtype = torch.float16 if device == "cuda" else torch.float32
        t0 = time.time()
        htok = AutoTokenizer.from_pretrained(helper)
        hmodel = _from_pretrained(helper, dtype).to(device).eval()
        hmodel.config.use_cache = True
        STATE.update(helper=hmodel, helper_tok=htok, helper_name=helper)
        print(f"loaded helper {helper} on {device} in {time.time() - t0:.0f}s")


def chat_ids(tok, messages):
    """Plain list of ids; transformers 4.x returns a list, 5.x a dict-like."""
    out = tok.apply_chat_template(messages, add_generation_prompt=True, tokenize=True)
    if hasattr(out, "keys") or isinstance(out, dict):
        out = out["input_ids"]
    if len(out) and isinstance(out[0], (list, tuple)):
        out = out[0]
    return [int(t) for t in out]


def available_models():
    names = []
    if STATE["has_adapter"]:
        names.append(TRAINED)
    names.append(BASE)
    if STATE["helper"] is not None:
        names.append(HELPER)
    return names


def generate(messages, which=TRAINED, temperature=0.6, max_tokens=200):
    """Runs one of the named models. Raises ValueError for a name not loaded."""
    import torch

    if which == HELPER:
        if STATE["helper"] is None:
            raise ValueError(f"{HELPER} is not loaded; start serve.py with --helper")
        tok, model = STATE["helper_tok"], STATE["helper"]
    elif which in (TRAINED, BASE):
        if which == TRAINED and not STATE["has_adapter"]:
            raise ValueError(f"{TRAINED} is not available (no adapter); use {BASE}")
        tok, model = STATE["tokenizer"], STATE["model"]
    else:
        raise ValueError(f"unknown model '{which}'; available: {', '.join(available_models())}")

    ids = torch.tensor([chat_ids(tok, messages)]).to(STATE["device"])
    kwargs = dict(
        max_new_tokens=max_tokens,
        min_new_tokens=MIN_NEW_TOKENS,
        do_sample=temperature > 0,
        temperature=max(temperature, 1e-3),
        top_p=0.9,
        repetition_penalty=1.05,
        pad_token_id=tok.pad_token_id,
    )
    with GPU_LOCK, torch.inference_mode():
        if which == BASE and STATE["has_adapter"]:
            with model.disable_adapter():
                out = model.generate(ids, **kwargs)
        else:
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
    server_version = "Elenchus/1.1"

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
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization, ngrok-skip-browser-warning")
        self.send_header("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
        self.end_headers()

    def do_GET(self):
        path = self.path.split("?")[0]
        if path in ("/", "/index.html"):
            page = (HERE / "web" / "index.html").read_text(encoding="utf-8")
            return self._send(200, page, "text/html; charset=utf-8")
        if path.startswith("/v1/models"):
            return self._json(200, {"data": [{"id": n, "object": "model"} for n in available_models()]})
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
        except ValueError as e:
            self._json(404, {"error": {"message": str(e)}})
        except Exception as e:
            traceback.print_exc()
            self._json(500, {"error": {"message": f"{type(e).__name__}: {e}"}})

    def _api(self, req):
        """The OpenAI-compatible endpoint the VS Code extension uses."""
        messages = req.get("messages") or []
        which = str(req.get("model") or TRAINED)
        t0 = time.time()
        text = generate(
            messages,
            which=which,
            temperature=float(req.get("temperature", 0.6)),
            max_tokens=min(int(req.get("max_tokens", 200)), MAX_TOKENS_CAP),
        )
        print(f"[api {time.time() - t0:5.1f}s {which:15s}] {text[:70].replace(chr(10), ' ')}")
        self._json(200, {
            "id": "local", "object": "chat.completion", "model": which,
            "choices": [{"index": 0, "message": {"role": "assistant", "content": text},
                         "finish_reason": "stop"}],
        })

    def _ask(self, req):
        """The browser page. Builds the first turn the way the extension does."""
        from guardrail_py import inspect

        history = req.get("history") or []
        code = (req.get("code") or "").strip()
        question = (req.get("question") or "").strip()
        which = TRAINED if bool(req.get("trained", True)) else BASE

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
        text = generate(messages, which=which, max_tokens=220)
        took = time.time() - t0
        reasons = inspect(text)
        print(f"[web {took:5.1f}s {which:15s}] {'BLOCKED ' if reasons else ''}{text[:60].replace(chr(10), ' ')}")

        self._json(200, {
            "reply": text, "blocked": bool(reasons), "reasons": reasons,
            "seconds": round(took, 1), "model": which, "turn": messages[-1]["content"],
        })

    def log_message(self, *_):
        pass  # the replies themselves are the useful log


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", action="store_true", help="serve only the untrained base model")
    ap.add_argument("--helper", default=None, metavar="HF_MODEL_ID",
                    help="also load a larger untrained model as elenchus-helper, "
                         "e.g. Qwen/Qwen2.5-Coder-1.5B-Instruct")
    ap.add_argument("--port", type=int, default=PORT)
    ap.add_argument("--host", default="127.0.0.1",
                    help="use 0.0.0.0 to accept connections from your local network")
    args = ap.parse_args()

    load(force_base=args.base, helper=args.helper)
    print(f"\n  web page : http://{args.host}:{args.port}/")
    print(f"  API      : http://{args.host}:{args.port}/v1")
    print(f"  models   : {', '.join(available_models())}")
    print(f"  extension: provider = local, model = {TRAINED}")
    print("\n  Ctrl+C to stop\n")
    try:
        ThreadingHTTPServer((args.host, args.port), Handler).serve_forever()
    except KeyboardInterrupt:
        print("\nstopped")
