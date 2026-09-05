"""
Turns the Socratic Debugging Benchmark into chat-format training examples.

Input:  model/data/socratic-debugging-benchmark/socratic_debugging_benchmark/v2_sigcse/{train,testset}/*.txt
Output: model/data/train.jsonl and model/data/test.jsonl

Each output line is one training example in the OpenAI chat shape:

    {"messages": [{"role": "system", ...}, {"role": "user", ...}, {"role": "assistant", ...}, ...]}

The LAST message is always the tutor turn we want the model to learn to
produce. Everything before it is the context the tutor saw. This mirrors the
extension exactly: the first user message is built the way buildFirstTurn()
builds it, with the same " N | " line numbering, so what the model trains on is
what it will be shown at runtime.

Runs on the plain standard library — no torch, no transformers needed here.

    python model/prepare_data.py
"""

import json
import os
import random
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
DATA = HERE / "data" / "socratic-debugging-benchmark" / "socratic_debugging_benchmark" / "v2_sigcse"
OUT = HERE / "data"

# The system prompt the fine-tuned model is trained with. It is short on
# purpose: the whole point of fine-tuning is that the behaviour lives in the
# weights, not in a 900-token instruction. The extension reads the same file
# when it talks to the local model, so training and serving always agree.
SYSTEM_PROMPT = (HERE / "compact_prompt.txt").read_text(encoding="utf-8").strip()
SYSTEM_PROMPT_STRONG = (HERE / "compact_prompt_strong.txt").read_text(encoding="utf-8").strip()

# The first training run appended the benchmark's problem statement to EVERY
# opening turn. The extension never sends one, so at serving time the model met
# a shape it had never seen and started inventing tasks ("how many times does
# 'hello' appear?"). Now it sees the statement on roughly half the examples and
# learns to cope either way. Seeded, so the split is reproducible.
TASK_STATEMENT_PROBABILITY = 0.5
random.seed(1337)

# Tutors in the benchmark say "look at line 11" constantly. When the expert's
# own reply names a line, a second copy of that example is emitted under the
# Strong-hint prompt with a matching "LINES: 11" marker appended. That is the
# training signal Strong hint mode needs, mined from what the expert already
# said rather than invented.
LINE_MENTION = re.compile(
    r"\blines?\s+(\d{1,4})(?:\s*(?:-|–|—|to|through|and)\s*(\d{1,4}))?\b", re.I
)


def mined_marker(text):
    m = LINE_MENTION.search(text or "")
    if not m:
        return None
    start = int(m.group(1))
    end = int(m.group(2)) if m.group(2) else start
    if start < 1 or end < start:
        return None
    return f"LINES: {start}" if start == end else f"LINES: {start}-{end}"

# How much of a long conversation the model sees: the opening turn (which
# carries the code) plus this many of the most recent turns. Same idea as the
# extension's trimThread — bounded context keeps sequences short enough to
# train on a small GPU.
KEEP_RECENT_TURNS = 6

# Each tutor turn in the dataset comes with alternative phrasings (<alt>). Each
# one is another correct answer for the same context, so we use them as extra
# examples — but cap it, or dialogues with many alternatives dominate.
MAX_ALTS_PER_TURN = 2

# The problem statement is long; keep enough for the tutor to know the task.
MAX_PROBLEM_CHARS = 700


def tag(text, name):
    m = re.search(rf"<{name}>(.*?)</{name}>", text, re.S)
    return m.group(1).strip("\n") if m else ""


def strip_dataset_numbering(code):
    """The dataset writes '11.    for i in ...'. Remove that prefix."""
    lines = []
    for line in code.strip("\n").split("\n"):
        lines.append(re.sub(r"^\s*\d+\.\s?", "", line))
    return "\n".join(lines).rstrip()


def number_lines(code):
    """The extension's numbering: ' 3 | total = 0', width-padded."""
    lines = code.replace("\r\n", "\n").split("\n")
    width = len(str(len(lines)))
    return "\n".join(f"{str(i + 1).rjust(width)} | {line}" for i, line in enumerate(lines))


def build_first_turn(code, question):
    """Byte-for-byte the shape buildFirstTurn() produces in prompt.js."""
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


def parse_dialogue(text):
    """
    Returns a list of turns in order. Each turn is a dict:
      {"role": "user"|"assistant", "text": str, "alts": [str], "code": str|None}
    <alt> lines attach to the turn above them. <code>...</code> blocks attach
    to the user turn above them (the student pasted updated code).
    """
    turns = []
    lines = text.split("\n")
    i = 0
    while i < len(lines):
        line = lines[i]
        stripped = line.strip()

        if line.startswith("User: "):
            turns.append({"role": "user", "text": line[len("User: "):].strip(), "alts": [], "code": None})
        elif line.startswith("Assistant: "):
            turns.append({"role": "assistant", "text": line[len("Assistant: "):].strip(), "alts": [], "code": None})
        elif stripped.startswith("<alt>"):
            if turns:
                turns[-1]["alts"].append(stripped[len("<alt>"):].strip())
        elif stripped == "<code>":
            block = []
            i += 1
            while i < len(lines) and lines[i].strip() != "</code>":
                block.append(lines[i])
                i += 1
            # Attach to the most recent user turn.
            for t in reversed(turns):
                if t["role"] == "user":
                    t["code"] = strip_dataset_numbering("\n".join(block))
                    break
        elif stripped == "":
            pass
        else:
            # A continuation line of whatever came last.
            if turns:
                turns[-1]["text"] += "\n" + stripped
        i += 1

    # The tutor's private reasoning is not part of what it says out loud.
    for t in turns:
        t["text"] = re.sub(r"<thought_block>.*?</thought_block>", "", t["text"], flags=re.S).strip()
        t["alts"] = [re.sub(r"<thought_block>.*?</thought_block>", "", a, flags=re.S).strip() for a in t["alts"]]
    return turns


def dialogue_to_examples(file_text):
    problem = tag(file_text, "problem").strip()
    bug_code = strip_dataset_numbering(tag(file_text, "bug_code"))
    turns = parse_dialogue(tag(file_text, "dialogue"))
    if not bug_code or not turns or turns[0]["role"] != "user":
        return []

    # Rebuild the conversation as chat messages.
    messages = [{"role": "system", "content": SYSTEM_PROMPT}]
    first_question = turns[0]["text"]
    if problem and random.random() < TASK_STATEMENT_PROBABILITY:
        first_question += "\n\nThe task I'm trying to solve: " + problem[:MAX_PROBLEM_CHARS]
    messages.append({"role": "user", "content": build_first_turn(bug_code, first_question)})

    examples = []
    for t in turns[1:]:
        if t["role"] == "assistant":
            # Every assistant turn is a training target, against the context so far.
            context = trim(messages)
            targets = [t["text"]] + t["alts"][:MAX_ALTS_PER_TURN]
            for target in targets:
                if target:
                    examples.append({"messages": context + [{"role": "assistant", "content": target}]})
            # Strong-hint variant: same context under the strong prompt, with the
            # line the expert named appended as a marker. Main text only, so the
            # alternatives do not multiply it.
            marker = mined_marker(t["text"])
            if marker:
                strong_context = [{"role": "system", "content": SYSTEM_PROMPT_STRONG}] + context[1:]
                examples.append({
                    "messages": strong_context + [{"role": "assistant", "content": t["text"] + "\n\n" + marker}],
                    "variant": "strong",
                })
            messages.append({"role": "assistant", "content": t["text"]})
        else:
            content = t["text"]
            if t["code"]:
                content += "\n\nHere is my updated code:\n\n" + number_lines(t["code"])
            # Two user turns in a row happen when a student turn had no reply
            # recorded; merge rather than emit a shape providers reject.
            if messages[-1]["role"] == "user":
                messages[-1]["content"] += "\n\n" + content
            else:
                messages.append({"role": "user", "content": content})
    return examples


def trim(messages):
    """System + the opening user turn + the last KEEP_RECENT_TURNS turns."""
    head, rest = messages[:2], messages[2:]
    tail = rest[-KEEP_RECENT_TURNS:]
    # Never start the tail on a user turn right after the opening user turn.
    if tail and tail[0]["role"] == "user" and len(rest) > KEEP_RECENT_TURNS:
        tail = rest[-(KEEP_RECENT_TURNS + 1):]
    return head + tail


def convert(split_dir, out_path):
    files = sorted(Path(split_dir).glob("*.txt"))
    n_examples = 0
    n_strong = 0
    lengths = []
    with open(out_path, "w", encoding="utf-8") as f:
        for fp in files:
            for ex in dialogue_to_examples(fp.read_text(encoding="utf-8")):
                f.write(json.dumps(ex, ensure_ascii=False) + "\n")
                n_examples += 1
                if ex.get("variant") == "strong":
                    n_strong += 1
                lengths.append(sum(len(m["content"]) for m in ex["messages"]))
    lengths.sort()
    return {
        "files": len(files),
        "examples": n_examples,
        "strong": n_strong,
        "chars_avg": int(sum(lengths) / max(1, len(lengths))),
        "chars_p90": lengths[int(len(lengths) * 0.9)] if lengths else 0,
        "chars_max": lengths[-1] if lengths else 0,
    }


if __name__ == "__main__":
    if not DATA.exists():
        sys.exit(f"Dataset not found at {DATA}. Clone taisazero/socratic-debugging-benchmark into model/data/ first.")
    OUT.mkdir(parents=True, exist_ok=True)
    for split, name in (("train", "train"), ("testset", "test")):
        stats = convert(DATA / split, OUT / f"{name}.jsonl")
        print(f"{name}: {stats['files']} dialogues -> {stats['examples']} examples "
              f"({stats['strong']} strong-hint variants with mined LINES markers) | "
              f"chars avg {stats['chars_avg']}, p90 {stats['chars_p90']}, max {stats['chars_max']}")
    print(f"written to {OUT}")
