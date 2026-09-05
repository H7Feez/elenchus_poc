# The model

A small fine-tuned Socratic tutor that runs on a laptop and plugs into the
extension. Three scripts, run in order.

## Data

The [Socratic Debugging Benchmark](https://github.com/taisazero/socratic-debugging-benchmark)
(Al-Hossami et al., BEA@ACL 2023 and SIGCSE 2024): 134 training dialogues and
16 test dialogues in which a human expert Socratically guides a novice through
a buggy Python program. Each tutor turn comes with alternative phrasings, which
we use as extra examples. The repository has no licence file, so it is fetched
rather than checked in:

```powershell
git clone --depth 1 https://github.com/taisazero/socratic-debugging-benchmark.git model/data/socratic-debugging-benchmark
```

Cite both papers in the report if the model is used.

## Setup

Into whichever Python environment you use (the team's is `sic_ai_env`):

```powershell
python -m pip install torch --index-url https://download.pytorch.org/whl/cu126
python -m pip install transformers peft accelerate
```

The first line is the GPU build. If PyTorch cannot use your card, the scripts
fall back to the CPU on their own.

## Run

```powershell
python model/prepare_data.py      # seconds: dataset -> model/data/{train,test}.jsonl
python model/train.py             # 20-40 min on a small GPU; use --limit 400 on CPU
python model/serve.py             # serves it on http://127.0.0.1:8008/v1
```

Then in VS Code settings: `socraticTutor.provider` = `local`,
`socraticTutor.model` = `elenchus`. Run *Socratic Tutor: Test Connection*.

## The before/after comparison

```powershell
python model/serve.py --base
```

serves the same base model with the training removed. Ask the same question of
both and compare. The guardrail's fire rate (*Show Session Stats*) on each is
the first number for the evaluation section.

## What the pieces are

| File | What it does |
|---|---|
| `compact_prompt.txt` | The short system prompt the model is trained with. The extension reads the same file when talking to the local model, so training and serving cannot drift apart. |
| `prepare_data.py` | Converts the benchmark's XML-ish dialogues into chat examples in exactly the shape the extension sends: same `" 3 \| code"` line numbering, same opening message. Standard library only. |
| `train.py` | LoRA fine-tune of Qwen2.5-Coder-0.5B-Instruct. Graded only on the tutor's replies; the student's words are context. Saves the adapter to `model/out/adapter`. |
| `serve.py` | A minimal HTTP server speaking the OpenAI chat shape, so the extension needs no special code path. |

## What this model is and is not

It is a **supervised fine-tune**: it has learned to imitate the benchmark's
tutors. It is trained for Hint mode only — the benchmark has no line markers,
so Strong hint and Direct answer will still behave like Hint on this model.

It is trained for Hint mode. `prepare_data.py` now also emits Strong-hint
examples with `LINES:` markers mined from the experts' own "look at line 11"
phrasing, and shows the problem statement on only half the opening turns
(the first run showed it on all of them, and the served model, which never
gets one, started inventing tasks). **The next training run picks both up;
the current adapter predates them.**

Until then, `serve.py --helper Qwen/Qwen2.5-Coder-1.5B-Instruct` loads a
larger untrained model as `elenchus-helper`, and the extension sends Strong
hint, Direct answer and concept questions there when no Groq key is stored.
Whether that helper follows the marker and fix contracts well enough is
unverified: `compare.py`-style measurement is the next step.

It is **not** the RLHF/DPO method from the ACE-RLHF paper. That is the next
step, and it needs this one first: DPO trains on pairs of a better and a worse
reply for the same context, and the guardrail is a ready-made way to label the
worse ones.
