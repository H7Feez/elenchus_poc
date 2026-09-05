"""
Assembles a Hugging Face Space that serves the fine-tuned model.

    python model/build_space.py

Produces model/space/, a self-contained folder ready to push to a Space:
the server, the web page, the guardrail, the prompt, and the trained adapter.
The base model is not copied; the Space downloads it from the Hub on first run.

The Space runs the same serve.py the extension already talks to, so the API
shape is identical whether it is answering from your laptop or from HF.
"""

import shutil
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
OUT = HERE / "space"

DOCKERFILE = """\
# Hugging Face Spaces run as uid 1000 and expect the app on port 7860.
FROM python:3.11-slim

RUN useradd -m -u 1000 user
USER user
ENV PATH="/home/user/.local/bin:$PATH" \\
    HF_HOME=/home/user/.cache/huggingface \\
    HF_HUB_DISABLE_SYMLINKS_WARNING=1 \\
    PYTHONUNBUFFERED=1

WORKDIR /home/user/app

# CPU-only torch: the GPU build is ~2.5 GB and useless on a free Space.
RUN pip install --user --no-cache-dir \\
      torch --index-url https://download.pytorch.org/whl/cpu
RUN pip install --user --no-cache-dir \\
      "transformers>=4.44" "peft>=0.11" accelerate safetensors

COPY --chown=user . /home/user/app

EXPOSE 7860
CMD ["python", "serve.py", "--host", "0.0.0.0", "--port", "7860"]
"""

README = """\
---
title: Elenchus Socratic Tutor
emoji: 🦉
colorFrom: gray
colorTo: blue
sdk: docker
app_port: 7860
pinned: false
---

# Elenchus — Socratic Debugging Tutor

A 0.5B model fine-tuned to guide novice programmers to their own bugs instead
of handing over fixes. Built for the SIC AI capstone.

- **Base model:** Qwen/Qwen2.5-Coder-0.5B-Instruct
- **Training:** LoRA supervised fine-tuning on the
  [Socratic Debugging Benchmark](https://github.com/taisazero/socratic-debugging-benchmark)
  (Al-Hossami et al., BEA@ACL 2023 / SIGCSE 2024), 134 expert dialogues
- **Held-out test loss:** 1.97 before training, 1.44 after

## Use it in a browser

Open the Space and paste some buggy Python. Toggle between the fine-tuned model
and the untrained base to see what the training changed.

## Use it from the VS Code extension

The Space exposes an OpenAI-compatible API:

```
POST https://<this-space>.hf.space/v1/chat/completions
```

Models: `elenchus` (fine-tuned) and `elenchus-base` (untrained, for comparison).
No API key.

## Note

Free Spaces run on CPU and sleep after inactivity, so the first request after a
quiet period takes a minute or so to wake up, and replies take several seconds.
"""

# Hugging Face refuses plain files over 10 MB, so anything big goes through
# Git LFS. tokenizer.json is ~11 MB and would otherwise be rejected on push.
GITATTRIBUTES = """\
*.safetensors filter=lfs diff=lfs merge=lfs -text
*.bin filter=lfs diff=lfs merge=lfs -text
tokenizer.json filter=lfs diff=lfs merge=lfs -text
"""

GITIGNORE = """\
__pycache__/
*.pyc
"""


def main():
    adapter = HERE / "out" / "adapter"
    if not adapter.exists():
        sys.exit(f"No adapter at {adapter}. Run model/train.py first.")

    # Clear previous content but keep .git: once the Space has been pushed,
    # this folder is a live repository and deleting it would take the Space's
    # history with it. Re-running should update the files in place so the next
    # commit is an ordinary edit.
    OUT.mkdir(parents=True, exist_ok=True)
    for item in OUT.iterdir():
        if item.name == ".git":
            continue
        if item.is_dir():
            shutil.rmtree(item, ignore_errors=True)
        else:
            item.unlink(missing_ok=True)

    # The server and everything it imports at runtime.
    for name in ("serve.py", "guardrail_py.py", "compact_prompt.txt", "compact_prompt_strong.txt"):
        shutil.copy2(HERE / name, OUT / name)
    ignore = shutil.ignore_patterns("__pycache__", "*.pyc")
    shutil.copytree(HERE / "web", OUT / "web", ignore=ignore)

    # The trained weights. train.py's default output path is what serve.py
    # looks for, so the layout is preserved rather than reconfigured.
    shutil.copytree(adapter, OUT / "out" / "adapter", ignore=ignore)

    (OUT / "Dockerfile").write_text(DOCKERFILE, encoding="utf-8")
    (OUT / "README.md").write_text(README, encoding="utf-8")
    (OUT / ".gitattributes").write_text(GITATTRIBUTES, encoding="utf-8")
    (OUT / ".gitignore").write_text(GITIGNORE, encoding="utf-8")

    # .git holds the LFS copies of what was already pushed; not part of a push.
    files = [f for f in OUT.rglob("*") if f.is_file() and ".git" not in f.relative_to(OUT).parts]
    total = sum(f.stat().st_size for f in files)
    print(f"built {OUT}")
    for f in sorted(files):
        rel = f.relative_to(OUT)
        print(f"  {str(rel):40s} {f.stat().st_size / 1024:8.0f} KB")
    print(f"\ncontent size: {total / 1024 / 1024:.0f} MB (only changed files are uploaded on a re-push)")


if __name__ == "__main__":
    main()
