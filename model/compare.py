"""
Side-by-side: the base model versus the fine-tuned one, on unseen dialogues.

    python model/compare.py            # 3 held-out test dialogues
    python model/compare.py --n 6

Loads the base model once and toggles the adapter on and off, so both replies
come from an identical setup and the only difference is the training. Runs each
reply through the extension's own guardrail and reports the fire rate, which is
the number for the evaluation section.
"""

import argparse
import json
import os
import re
import sys
from pathlib import Path

os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")
HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

# The guardrail lives in JavaScript, so its rules are mirrored here. Kept in one
# place and checked against guardrail.js by test/smoke.js expectations.
SPOILER_PHRASES = [
    r"\bthe (bug|problem|issue|error) is\b",
    r"\bthe fix is\b",
    r"\byou (need to|should) (change|replace|remove)\b",
    r"\byou (need to|should|can|could) add\s+`[^`]+`",
    r"\bchange (line|it) .* to\b",
    r"\breplace .* with\b",
    r"\bhere('s| is) the (corrected|fixed|working)\b",
    r"\bsimply (change|replace|add)\b",
]
CODE_LINE = [
    r"^\s*(def|class)\s+\w+\s*\(",
    r"^\s*(function|const|let|var)\s+\w+\s*[=(]",
    r"^\s*(public|private|protected)\s+\w+",
    r"^\s*(if|elif|else|for|while|try|except|switch)\b.*[:{]\s*$",
    r"^\s*return\s+.+",
    r"^\s*\w+\s*=\s*.+",
]
MAX_WORDS = 160


def guardrail(reply):
    """Returns the list of reasons the Direct Output Filter would block this."""
    reasons = []
    text = (reply or "").strip()
    if not text:
        return ["empty reply"]
    if "```" in text:
        reasons.append("fenced code block")
    run = best = 0
    for line in text.split("\n"):
        run = run + 1 if any(re.search(p, line) for p in CODE_LINE) else 0
        best = max(best, run)
    if best > 2:
        reasons.append(f"{best} consecutive code-like lines")
    for sentence in re.split(r"(?<=[.!?])\s+", text):
        if sentence.strip().endswith("?"):
            continue  # a question is the tutor doing its job
        for p in SPOILER_PHRASES:
            if re.search(p, sentence, re.I):
                reasons.append("states the answer directly")
                break
        else:
            continue
        break
    words = len(text.split())
    if words > MAX_WORDS:
        reasons.append(f"{words} words, over {MAX_WORDS}")
    return reasons


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--n", type=int, default=3)
    ap.add_argument("--any-turn", action="store_true",
                    help="sample any turn, not just the opening one")
    ap.add_argument("--max-tokens", type=int, default=110)
    ap.add_argument("--quiet", action="store_true", help="counts only, no transcripts")
    args = ap.parse_args()

    import torch
    from transformers import AutoTokenizer
    from peft import PeftModel
    from train import load_model, BASE_MODEL, chat_ids

    adapter = HERE / "out" / "adapter"
    if not adapter.exists():
        sys.exit(f"No adapter at {adapter}. Run train.py first.")

    tok = AutoTokenizer.from_pretrained(BASE_MODEL)
    model = load_model(BASE_MODEL)
    model = PeftModel.from_pretrained(model, str(adapter)).to("cuda").eval()
    model.config.use_cache = True

    rows = [json.loads(l) for l in open(HERE / "data" / "test.jsonl", encoding="utf-8")]
    if not args.any_turn:
        # Opening turns only: system + the student's code + the tutor's first
        # reply. Sampling mid-dialogue instead lands on "Very good." turns,
        # where every model looks identical and nothing is being tested.
        rows = [r for r in rows if len(r["messages"]) == 3]
    # Spread across the file so the samples come from different dialogues.
    picks = rows[:: max(1, len(rows) // args.n)][: args.n]

    def reply(messages, trained):
        ids = torch.tensor([chat_ids(tok, messages, add_generation_prompt=True)]).cuda()
        gen = dict(max_new_tokens=args.max_tokens, do_sample=True, temperature=0.6,
                   top_p=0.9, repetition_penalty=1.05, pad_token_id=tok.pad_token_id)
        with torch.inference_mode():
            if trained:
                out = model.generate(ids, **gen)
            else:
                with model.disable_adapter():
                    out = model.generate(ids, **gen)
        return tok.decode(out[0][ids.shape[1]:], skip_special_tokens=True).strip()

    fired = {"base": 0, "trained": 0}
    words = {"base": 0, "trained": 0}
    asked = {"base": 0, "trained": 0}
    why = {"base": [], "trained": []}

    for i, row in enumerate(picks, 1):
        context = row["messages"][:-1]
        expert = row["messages"][-1]["content"]
        student = context[-1]["content"]
        if not args.quiet:
            print("=" * 72)
            print(f"DIALOGUE {i}\n")
            print("STUDENT SAID:\n  " + student.replace("\n", "\n  ")[:400] + "\n")
        for label, trained in (("BASE (untrained)", False), ("FINE-TUNED", True)):
            text = reply(context, trained)
            hits = guardrail(text)
            key = "trained" if trained else "base"
            if hits:
                fired[key] += 1
                why[key].extend(hits)
            words[key] += len(text.split())
            if "?" in text:
                asked[key] += 1
            if not args.quiet:
                print(f"{label}:\n  " + text.replace("\n", "\n  "))
                print(f"  [guardrail: {'BLOCKED - ' + '; '.join(hits) if hits else 'passed'}]\n")
        if not args.quiet:
            print("HUMAN EXPERT WROTE:\n  " + expert.replace("\n", "\n  ") + "\n")
        else:
            print(f"  {i}/{len(picks)}", end="\r", flush=True)

    n = len(picks)
    from collections import Counter
    print("\n" + "=" * 72)
    print(f"{n} unseen opening turns, max {args.max_tokens} new tokens\n")
    print(f"{'':22s}{'BASE':>10s}{'FINE-TUNED':>14s}")
    print(f"{'guardrail fired':22s}{fired['base']:>7d}/{n}{fired['trained']:>11d}/{n}")
    print(f"{'  as a rate':22s}{100*fired['base']/n:>9.0f}%{100*fired['trained']/n:>13.0f}%")
    print(f"{'contained a question':22s}{asked['base']:>7d}/{n}{asked['trained']:>11d}/{n}")
    print(f"{'mean words per reply':22s}{words['base']/n:>10.0f}{words['trained']/n:>14.0f}")
    for k in ("base", "trained"):
        if why[k]:
            print(f"\n{k} blocked for: {dict(Counter(why[k]))}")


if __name__ == "__main__":
    main()
