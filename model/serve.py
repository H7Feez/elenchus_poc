"""
Serves the fine-tuned model to the extension over HTTP.

    python model/serve.py            # base model + trained adapter
    python model/serve.py --base     # base model only, for a before/after comparison

Speaks the same /v1/chat/completions shape as Groq, so the extension needs only
three settings:  provider = local,  model = elenchus  (baseUrl defaults to
http://127.0.0.1:8008/v1).  Standard library only, apart from torch/transformers.
"""

import argparse
import json
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parent
ADAPTER = HERE / "out" / "adapter"
BASE_MODEL = "Qwen/Qwen2.5-Coder-0.5B-Instruct"
PORT = 8008

STATE = {"model": None, "tokenizer": None, "device": "cpu", "name": "elenchus"}


def load(use_base_only):
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

    if not use_base_only:
        if not ADAPTER.exists():
            sys.exit(f"No adapter at {ADAPTER}. Run model/train.py first, or pass --base.")
        from peft import PeftModel
        model = PeftModel.from_pretrained(model, str(ADAPTER))
        model = model.merge_and_unload()  # fold the adapter in; faster generation
        STATE["name"] = "elenchus"
    else:
        STATE["name"] = "elenchus-base"

    model.to(device).eval()
    STATE.update(model=model, tokenizer=tokenizer, device=device)
    print(f"loaded {STATE['name']} on {device}")


def chat_ids(tok, messages):
    """Plain list of ids; transformers 4.x returns a list, 5.x a dict-like."""
    out = tok.apply_chat_template(messages, add_generation_prompt=True, tokenize=True)
    if hasattr(out, "keys") or isinstance(out, dict):
        out = out["input_ids"]
    if len(out) and isinstance(out[0], (list, tuple)):
        out = out[0]
    return [int(t) for t in out]


def generate(messages, temperature, max_tokens):
    import torch
    tok, model = STATE["tokenizer"], STATE["model"]
    ids = torch.tensor([chat_ids(tok, messages)]).to(STATE["device"])
    with torch.inference_mode():
        out = model.generate(
            ids,
            max_new_tokens=max_tokens,
            do_sample=temperature > 0,
            temperature=max(temperature, 1e-3),
            top_p=0.9,
            repetition_penalty=1.05,
            pad_token_id=tok.pad_token_id,
        )
    return tok.decode(out[0][ids.shape[1]:], skip_special_tokens=True).strip()


class Handler(BaseHTTPRequestHandler):
    def _json(self, code, obj):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.startswith("/v1/models"):
            return self._json(200, {"data": [{"id": STATE["name"], "object": "model"}]})
        self._json(404, {"error": {"message": "not found"}})

    def do_POST(self):
        if not self.path.startswith("/v1/chat/completions"):
            return self._json(404, {"error": {"message": "not found"}})
        try:
            length = int(self.headers.get("Content-Length", "0"))
            req = json.loads(self.rfile.read(length) or b"{}")
            messages = req.get("messages") or []
            temperature = float(req.get("temperature", 0.6))
            max_tokens = int(req.get("max_tokens", 200))
            t0 = time.time()
            text = generate(messages, temperature, min(max_tokens, 400))
            print(f"[{time.time() - t0:5.1f}s] {text[:90].replace(chr(10), ' ')}...")
            self._json(200, {
                "id": "local",
                "object": "chat.completion",
                "model": STATE["name"],
                "choices": [{"index": 0, "message": {"role": "assistant", "content": text}, "finish_reason": "stop"}],
            })
        except Exception as e:
            self._json(500, {"error": {"message": f"{type(e).__name__}: {e}"}})

    def log_message(self, *_):
        pass  # keep the console for the replies themselves


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", action="store_true", help="serve the untrained base model")
    ap.add_argument("--port", type=int, default=PORT)
    args = ap.parse_args()
    load(args.base)
    print(f"listening on http://127.0.0.1:{args.port}/v1  — Ctrl+C to stop")
    print("extension settings:  provider = local   model = " + STATE["name"])
    try:
        ThreadingHTTPServer(("127.0.0.1", args.port), Handler).serve_forever()
    except KeyboardInterrupt:
        print("\nstopped")
